import { getCollection, } from "astro:content";
import { contentSections, isPublishedEntry, } from "../lib/content";
import { absoluteUrl, } from "../lib/site";

export async function GET() {
  const sectionEntries = await Promise.all(
    Object.entries(contentSections,).map(async ([section, config,],) => ({
      section,
      entries: (await getCollection(config.collection,)).filter(isPublishedEntry,),
    })),
  );

  const staticPages = [
    { url: "/", lastmod: null, },
    { url: "/privacy", lastmod: null, },
    { url: "/terms", lastmod: null, },
    ...sectionEntries.map(({ section, entries, },) => ({
      url: `/${section}`,
      lastmod: entries[0]?.data.updatedAt ?? null,
    })),
  ];

  const contentPages = sectionEntries.flatMap(({ entries, },) => (
    entries.map((entry,) => ({
      url: entry.data.canonicalPath,
      lastmod: entry.data.updatedAt ?? entry.data.publishedAt,
    }))
  ));

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...[...staticPages, ...contentPages,].map((item,) => (
      [
        "  <url>",
        `    <loc>${escapeXml(absoluteUrl(item.url,),)}</loc>`,
        item.lastmod ? `    <lastmod>${item.lastmod.toISOString()}</lastmod>` : null,
        "  </url>",
      ].filter(Boolean,).join("\n",)
    )),
    "</urlset>",
    "",
  ].join("\n",);

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
    },
  },);
}

function escapeXml(value: string,) {
  return value
    .replaceAll("&", "&amp;",)
    .replaceAll('"', "&quot;",)
    .replaceAll("'", "&apos;",)
    .replaceAll("<", "&lt;",)
    .replaceAll(">", "&gt;",);
}
