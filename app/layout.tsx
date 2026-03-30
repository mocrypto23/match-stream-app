import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://twofooty.com"),
  title: "TwoFooty",
  description: "بث مباشر بدون اعلانات",
  manifest: "/site.webmanifest",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "https://twofooty.com/",
    siteName: "TwoFooty",
    title: "TwoFooty",
    description: "بث مباشر بدون اعلانات",
    images: [
      {
        url: "/android-chrome-512x512.png",
        width: 512,
        height: 512,
        alt: "TwoFooty",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "TwoFooty",
    description: "بث مباشر بدون اعلانات",
    images: ["/android-chrome-512x512.png"],
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <meta name="clckd" content="8f5a84b24b73cf9815ded1b4bf3f8f5a" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
