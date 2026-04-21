import HeaderV2 from "@/components/v2/header-v2";
import FooterV2 from "@/components/v2/footer-v2";

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <HeaderV2 />
      <main className="flex-1">{children}</main>
      <FooterV2 />
    </div>
  );
}
