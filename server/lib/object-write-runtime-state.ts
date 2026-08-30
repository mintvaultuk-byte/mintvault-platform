import { objectWriteFinalizerRegistryComplete } from "./object-write-finalizer-registry";

let reconcilerInstalled = false;

export function objectWriteRuntimeInstalled(): boolean {
  return reconcilerInstalled && objectWriteFinalizerRegistryComplete();
}

export function objectWriteReconcilerInstalled(): boolean {
  return reconcilerInstalled;
}

export function markObjectWriteRuntimeInstalled(): void {
  reconcilerInstalled = true;
}

export function __resetObjectWriteRuntimeForTests(): void {
  reconcilerInstalled = false;
}
