// MintVault LiDE 400 ImageCaptureCore bridge.
//
// This is deliberately a tiny command-line adapter behind the existing
// Electron app—not a second watcher or GUI automation layer.  It discovers a
// local ICA scanner, locks the functional unit to the flatbed/RGB/TIFF/1200-DPI
// profile, receives the completed file URL from ImageCaptureCore, and writes a
// single JSON result for the Node controller.

@import Foundation;
@import ImageCaptureCore;

// Canon's ICA module has shipped `CanoScan LiDE 400`, `Canon LiDE 400`, and
// `LiDE 400` as the public ImageCaptureCore device name.  Accept only these
// identifiers; this is an alias normalization, not a broad scanner-name match.
static NSString *const kExpectedFullName = @"CanoScan LiDE 400";
static NSString *const kExpectedCanonName = @"Canon LiDE 400";
static NSString *const kExpectedShortName = @"LiDE 400";
static NSString *const kHelperVersion = @"1.0.1";
static NSInteger const kHelperProtocolVersion = 1;

@interface MintVaultLideBridge : NSObject <ICDeviceBrowserDelegate, ICScannerDeviceDelegate>
@property(nonatomic, strong) ICDeviceBrowser *browser;
@property(nonatomic, strong) ICScannerDevice *scanner;
@property(nonatomic, strong) NSURL *scanURL;
@property(nonatomic, strong) NSString *outputDirectory;
@property(nonatomic) double originXmm;
@property(nonatomic) double originYmm;
@property(nonatomic) double scanWidthMm;
@property(nonatomic) double scanHeightMm;
@property(nonatomic) BOOL calibration;
@property(nonatomic) BOOL positioningPreview;
@property(nonatomic, strong) NSDictionary *appliedScanAreaMm;
@property(nonatomic) BOOL scanning;
@property(nonatomic) BOOL complete;
@property(nonatomic, strong) NSDictionary *result;
@property(nonatomic, strong) NSMutableArray<NSDictionary *> *discoveredDevices;
@property(nonatomic) NSInteger functionalUnitProbeAttempts;
@property(nonatomic) BOOL profileConfigurationStarted;
@end

@implementation MintVaultLideBridge

- (BOOL)isExpected:(ICDevice *)device {
  NSString *name = device.name ?: @"";
  return [name caseInsensitiveCompare:kExpectedFullName] == NSOrderedSame ||
         [name caseInsensitiveCompare:kExpectedCanonName] == NSOrderedSame ||
         [name caseInsensitiveCompare:kExpectedShortName] == NSOrderedSame;
}

- (NSDictionary *)discoveryPayload:(ICDevice *)device {
  return @{
    @"name": device.name ?: @"",
    @"deviceId": device.UUIDString ?: @"",
    @"serial": device.serialNumberString ?: [NSNull null],
    @"transport": device.transportType ?: @"",
    @"location": device.locationDescription ?: @"",
  };
}

- (NSDictionary *)devicePayload:(ICDevice *)device ready:(BOOL)ready {
  return @{
    @"status": ready ? @"ready" : @"busy",
    @"manufacturer": @"Canon",
    @"model": device.name ?: @"",
    @"deviceId": device.UUIDString ?: @"",
    @"serial": device.serialNumberString ?: [NSNull null],
    @"transport": device.transportType ?: @"",
    @"location": device.locationDescription ?: @"",
    @"moduleVersion": device.moduleVersion ?: [NSNull null],
  };
}

- (NSDictionary *)functionalUnitDiagnostics:(ICScannerDevice *)scanner {
  ICScannerFunctionalUnit *unit = scanner.selectedFunctionalUnit;
  return @{
    @"availableFunctionalUnitTypes": scanner.availableFunctionalUnitTypes ?: @[],
    @"selectedFunctionalUnitType": unit ? @(unit.type) : [NSNull null],
  };
}

- (void)finish:(NSDictionary *)payload {
  if (self.complete) return;
  self.complete = YES;
  self.result = payload;
  [self.scanner requestCloseSession];
  [self.browser stop];
}

- (void)beginFlatbedConfiguration {
  if (self.complete || !self.scanning) return;
  ICScannerFunctionalUnit *unit = self.scanner.selectedFunctionalUnit;
  if (unit && unit.type == ICScannerFunctionalUnitTypeFlatbed) {
    [self scannerDevice:self.scanner didSelectFunctionalUnit:unit error:nil];
    return;
  }
  if ([self.scanner.availableFunctionalUnitTypes containsObject:@(ICScannerFunctionalUnitTypeFlatbed)]) {
    [self.scanner requestSelectFunctionalUnit:ICScannerFunctionalUnitTypeFlatbed];
    return;
  }
  // AirScan can report didOpenSession before it has populated the functional
  // unit array. Its subsequent automatic didSelect callback is authoritative;
  // give that asynchronous setup a bounded five seconds before rejecting the
  // profile, rather than issuing a premature invalid type-0 request.
  self.functionalUnitProbeAttempts += 1;
  if (self.functionalUnitProbeAttempts < 10) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.5 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      [self beginFlatbedConfiguration];
    });
    return;
  }
  NSMutableDictionary *payload = [[self devicePayload:self.scanner ready:NO] mutableCopy];
  payload[@"status"] = @"profile_unsupported";
  payload[@"stage"] = @"functional_unit";
  payload[@"error"] = @"Canon LiDE 400 did not expose a flatbed functional unit after session setup";
  [payload addEntriesFromDictionary:[self functionalUnitDiagnostics:self.scanner]];
  [self finish:payload];
}

- (void)deviceBrowser:(ICDeviceBrowser *)browser didAddDevice:(ICDevice *)device moreComing:(BOOL)moreComing {
  [self.discoveredDevices addObject:[self discoveryPayload:device]];
  if (![device isKindOfClass:[ICScannerDevice class]] || ![self isExpected:device]) return;
  self.scanner = (ICScannerDevice *)device;
  self.scanner.delegate = self;
  // A visible USB/ICA device is not necessarily available for acquisition.
  // Probe a session even for health checks, so the workstation never promises
  // "ready" while another process owns the scanner.
  [self.scanner requestOpenSession];
}

- (void)deviceBrowser:(ICDeviceBrowser *)browser didRemoveDevice:(ICDevice *)device moreGoing:(BOOL)moreGoing {
  if (self.scanner == device) [self finish:@{ @"status": @"disconnected", @"error": @"Canon LiDE 400 disconnected" }];
}

- (void)deviceBrowserDidEnumerateLocalDevices:(ICDeviceBrowser *)browser {
  if (!self.scanner && !self.complete && self.scanning) {
    // Keep browsing for the scan timeout: ICA modules occasionally announce a
    // newly plugged scanner after local enumeration has completed.
  }
}

- (void)device:(ICDevice *)device didOpenSessionWithError:(NSError *)error {
  if (error) {
    NSMutableDictionary *payload = [[self devicePayload:device ready:NO] mutableCopy];
    payload[@"error"] = error.localizedDescription ?: @"Unable to open Canon scanner";
    [self finish:payload];
    return;
  }
  if (!self.scanning) {
    [self finish:[self devicePayload:device ready:YES]];
    return;
  }
  [self beginFlatbedConfiguration];
}

- (void)device:(ICDevice *)device didCloseSessionWithError:(NSError *)error { (void)device; (void)error; }
- (void)didRemoveDevice:(ICDevice *)device { (void)device; [self finish:@{ @"status": @"disconnected", @"error": @"Canon LiDE 400 disconnected" }]; }

- (void)scannerDevice:(ICScannerDevice *)scanner didSelectFunctionalUnit:(ICScannerFunctionalUnit *)unit error:(NSError *)error {
  // AirScan may emit its automatic selection callback after the bounded probe
  // has observed the same selected unit. One physical request must map to one
  // scan, never two concurrent scans caused by duplicate driver callbacks.
  if (self.profileConfigurationStarted || self.complete) return;
  self.profileConfigurationStarted = YES;
  if (error || !unit || unit.type != ICScannerFunctionalUnitTypeFlatbed) {
    NSMutableDictionary *payload = [@{
      @"status": @"control_unavailable",
      @"stage": @"functional_unit",
      @"error": error.localizedDescription ?: @"LiDE flatbed functional unit unavailable",
    } mutableCopy];
    if (error) payload[@"errorCode"] = @(error.code);
    [payload addEntriesFromDictionary:[self functionalUnitDiagnostics:scanner]];
    [self finish:payload];
    return;
  }
  NSUInteger requestedResolution = self.positioningPreview ? 300 : 1200;
  if (![unit.supportedResolutions containsIndex:requestedResolution]) {
    [self finish:@{ @"status": @"profile_unsupported", @"error": [NSString stringWithFormat:@"LiDE driver does not expose %lu DPI", (unsigned long)requestedResolution] }];
    return;
  }
  if (![unit.supportedBitDepths containsIndex:ICScannerBitDepth8Bits]) {
    [self finish:@{ @"status": @"profile_unsupported", @"error": @"LiDE driver does not expose 8-bit RGB" }];
    return;
  }
  if (![unit.supportedMeasurementUnits containsIndex:ICScannerMeasurementUnitCentimeters]) {
    [self finish:@{ @"status": @"profile_unsupported", @"error": @"LiDE driver does not expose centimeter scan areas" }];
    return;
  }
  scanner.transferMode = ICScannerTransferModeFileBased;
  scanner.downloadsDirectory = [NSURL fileURLWithPath:self.outputDirectory isDirectory:YES];
  scanner.documentName = [NSString stringWithFormat:@"mintvault-lide-%@", NSUUID.UUID.UUIDString];
  scanner.documentUTI = self.positioningPreview ? @"public.jpeg" : @"public.tiff";
  unit.measurementUnit = ICScannerMeasurementUnitCentimeters;
  unit.pixelDataType = ICScannerPixelDataTypeRGB;
  unit.bitDepth = ICScannerBitDepth8Bits;
  unit.resolution = requestedResolution;
  unit.scanAreaOrientation = 1; // EXIF orientation 1: deterministic upright capture.
  // This is a physical ImageCaptureCore acquisition rectangle, not a later
  // Sharp/libvips crop. Profile scans and their disposable capability proof
  // both exercise the exact 100 x 130 mm ImageCaptureCore hardware ROI.
  if (self.positioningPreview) {
    // Deliberately broad, uncalibrated setup view. We read the active ICA
    // flatbed size in centimetres rather than guessing an X/Y, then request
    // the entire physically reported platen at 300 DPI as JPEG. This output
    // cannot masquerade as evidence because no TIFF is produced or exposed to
    // any server/session code.
    ICSize physical = unit.physicalSize;
    if (physical.width <= 0 || physical.height <= 0) {
      [self finish:@{ @"status": @"profile_unsupported", @"error": @"LiDE driver did not report a usable full-platen preview area" }];
      return;
    }
    unit.scanArea = NSMakeRect(0, 0, physical.width, physical.height);
  } else {
    unit.scanArea = NSMakeRect(
      self.originXmm / 10.0,
      self.originYmm / 10.0,
      self.scanWidthMm / 10.0,
      self.scanHeightMm / 10.0
    );
  }
  NSRect applied = unit.scanArea;
  self.appliedScanAreaMm = @{
    @"x": @(applied.origin.x * 10.0),
    @"y": @(applied.origin.y * 10.0),
    @"width": @(applied.size.width * 10.0),
    @"height": @(applied.size.height * 10.0),
  };
  if (unit.resolution != requestedResolution || unit.pixelDataType != ICScannerPixelDataTypeRGB || unit.bitDepth != ICScannerBitDepth8Bits) {
    [self finish:@{ @"status": @"profile_unsupported", @"error": @"LiDE driver did not apply the locked MintVault profile" }];
    return;
  }
  [scanner requestScan];
}

- (void)scannerDevice:(ICScannerDevice *)scanner didScanToURL:(NSURL *)url { (void)scanner; self.scanURL = url; }

- (void)scannerDevice:(ICScannerDevice *)scanner didCompleteScanWithError:(NSError *)error {
  if (error || !self.scanURL.isFileURL) {
    NSMutableDictionary *payload = [@{
      @"status": @"scan_failed",
      @"stage": @"scan",
      @"error": error.localizedDescription ?: @"LiDE did not return a TIFF file",
    } mutableCopy];
    if (error) payload[@"errorCode"] = @(error.code);
    [self finish:payload];
    return;
  }
  ICScannerFunctionalUnit *unit = scanner.selectedFunctionalUnit;
  NSMutableDictionary *payload = [[self devicePayload:scanner ready:YES] mutableCopy];
  payload[@"status"] = @"captured";
  payload[@"path"] = self.scanURL.path;
  payload[@"requestedDpi"] = @(self.positioningPreview ? 300 : 1200);
  payload[@"driverResolutionDpi"] = @(unit.resolution);
  payload[@"scanAreaMm"] = self.appliedScanAreaMm ?: @{
    @"x": @(self.originXmm), @"y": @(self.originYmm),
    @"width": @(self.scanWidthMm), @"height": @(self.scanHeightMm),
  };
  payload[@"captureKind"] = self.positioningPreview ? @"positioning_preview" : (self.calibration ? @"calibration" : @"profile");
  if (self.positioningPreview) {
    // This bridges one explicit contract to the JavaScript detector/renderer:
    // requested ImageCaptureCore scan-area millimetres map to an upright
    // orientation-1 raster. A non-upright JPEG is rejected by the client
    // rather than being silently rotated or mirrored before X/Y persistence.
    payload[@"previewCoordinateSpace"] = @"imagecapturecore-scan-area-upright-raster-v1";
    payload[@"previewRasterOrientation"] = @1;
  }
  [self finish:payload];
}

- (void)device:(ICDevice *)device didEncounterError:(NSError *)error {
  (void)device;
  [self finish:@{ @"status": @"scan_failed", @"error": error.localizedDescription ?: @"LiDE driver error" }];
}

@end

static void printJSON(NSDictionary *value) {
  NSMutableDictionary *versioned = [value mutableCopy];
  versioned[@"helperVersion"] = kHelperVersion;
  versioned[@"protocolVersion"] = @(kHelperProtocolVersion);
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:versioned options:0 error:&error];
  if (!data || error) data = [@"{\"status\":\"control_unavailable\",\"error\":\"Unable to encode bridge result\"}" dataUsingEncoding:NSUTF8StringEncoding];
  fwrite(data.bytes, 1, data.length, stdout);
  fputc('\n', stdout);
}

int main(int argc, const char * argv[]) {
  @autoreleasepool {
    BOOL profileScan = argc == 5 && strcmp(argv[1], "scan") == 0;
    BOOL calibrationScan = argc == 7 && strcmp(argv[1], "calibrate") == 0;
    BOOL positioningPreview = argc == 3 && strcmp(argv[1], "preview") == 0;
    BOOL scanning = profileScan || calibrationScan || positioningPreview;
    if (!scanning && !(argc == 2 && strcmp(argv[1], "health") == 0)) {
      printJSON(@{ @"status": @"control_unavailable", @"error": @"Usage: health | preview <output-dir> | scan <output-dir> <origin-x-mm> <origin-y-mm> | calibrate <output-dir> <origin-x-mm> <origin-y-mm> <width-mm> <height-mm>" });
      return 64;
    }
    MintVaultLideBridge *bridge = [MintVaultLideBridge new];
    bridge.scanning = scanning;
    bridge.calibration = calibrationScan;
    bridge.positioningPreview = positioningPreview;
    bridge.discoveredDevices = [NSMutableArray array];
    if (scanning) {
      bridge.outputDirectory = [NSString stringWithUTF8String:argv[2]];
      bridge.originXmm = positioningPreview ? 0.0 : strtod(argv[3], NULL);
      bridge.originYmm = positioningPreview ? 0.0 : strtod(argv[4], NULL);
      bridge.scanWidthMm = profileScan ? 100.0 : (calibrationScan ? strtod(argv[5], NULL) : 0.0);
      bridge.scanHeightMm = profileScan ? 130.0 : (calibrationScan ? strtod(argv[6], NULL) : 0.0);
      if (!positioningPreview && (
        bridge.originXmm < 0 || bridge.originYmm < 0 ||
        bridge.scanWidthMm <= 0 || bridge.scanHeightMm <= 0 ||
        bridge.originXmm + bridge.scanWidthMm > 216.0 ||
        bridge.originYmm + bridge.scanHeightMm > 297.0
      )) {
        printJSON(@{ @"status": @"control_unavailable", @"error": @"LiDE scan area is outside the 216 x 297 mm platen" });
        return 64;
      }
      if (calibrationScan && (bridge.scanWidthMm < 100.0 || bridge.scanHeightMm < 130.0)) {
        printJSON(@{ @"status": @"control_unavailable", @"error": @"LiDE calibration area must be at least 100 x 130 mm" });
        return 64;
      }
    }
    bridge.browser = [ICDeviceBrowser new];
    bridge.browser.delegate = bridge;
    bridge.browser.browsedDeviceTypeMask = ICDeviceTypeMaskScanner | ICDeviceLocationTypeMaskLocal;
    [bridge.browser start];
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:scanning ? 300.0 : 4.0];
    while (!bridge.complete && deadline.timeIntervalSinceNow > 0) {
      [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
    }
    if (!bridge.complete) {
      if (bridge.scanner) {
        NSMutableDictionary *payload = [[bridge devicePayload:bridge.scanner ready:NO] mutableCopy];
        payload[@"error"] = @"Canon LiDE 400 is visible but ImageCaptureCore did not open a session; the device is busy or its driver is unresponsive";
        payload[@"discoveredDevices"] = bridge.discoveredDevices ?: @[];
        [bridge finish:payload];
      } else {
        [bridge finish:@{
          @"status": @"disconnected",
          @"error": @"Canon CanoScan LiDE 400 not detected by Image Capture",
          @"discoveredDevices": bridge.discoveredDevices ?: @[],
        }];
      }
    }
    printJSON(bridge.result ?: @{ @"status": @"control_unavailable", @"error": @"No scanner result" });
    return [bridge.result[@"status"] isEqual:@"captured"] || [bridge.result[@"status"] isEqual:@"ready"] ? 0 : 1;
  }
}
