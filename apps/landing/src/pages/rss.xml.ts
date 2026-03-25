import { getCollection, } from "astro:content";
import { contentSections, isPublishedEntry, sortContentEntries, } from "../lib/content";
import { absoluteUrl, siteConfig, } from "../lib/site";

export async function GET() {
  const sectionEntries = await Promise.all(
    Object.values(contentSections,).map(async (config,) => (
      (await getCollection(config.collection,)).filter(isPublishedEntry,)
    )),
  );
  const items = sortContentEntries(sectionEntries.flat(),).slice(0, 50,);

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${escapeXml(`${siteConfig.name} content feed`,)}</title>`,
    `    <description>${escapeXml(siteConfig.defaultDescription,)}</description>`,
    `    <link>${escapeXml(siteConfig.siteUrl,)}</link>`,
    ...items.map((entry,) => (
      [
        "    <item>",
        `      <title>${escapeXml(entry.data.title,)}</title>`,
        `      <description>${escapeXml(entry.data.summary,)}</description>`,
        `      <link>${escapeXml(absoluteUrl(entry.data.canonicalPath,),)}</link>`,
        `      <guid>${escapeXml(absoluteUrl(entry.data.canonicalPath,),)}</guid>`,
        `      <pubDate>${(entry.data.updatedAt ?? entry.data.publishedAt).toUTCString()}</pubDate>`,
        "    </item>",
      ].join("\n",)
    )),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n",);

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
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
