import type { Metadata, Viewport } from "next";
import "./styles.css";
import { pharmacyBrand } from "@/lib/brand";

export const metadata: Metadata = {
  title: pharmacyBrand.name,
  description: "Control de ventas, inventario y operación durante apagones.",
  robots: { index: false, follow: false },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "default", title: pharmacyBrand.name },
  icons: { icon: "/icon-192.png", apple: "/icon-192.png" },
};
export const viewport: Viewport = { themeColor: "#f3f6f4", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="es-VE"><body>{children}</body></html>;
}
