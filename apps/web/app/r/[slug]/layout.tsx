import type { Metadata } from "next";

export async function generateMetadata({ params }: LayoutProps<"/r/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  return { manifest: `/r/${slug}/manifest.webmanifest` };
}

export default function RestaurantLayout({ children }: LayoutProps<"/r/[slug]">) {
  return children;
}
