import { absoluteUrl, } from "../lib/site";

export function GET() {
  return new Response(
    [
      "User-agent: *",
      "Allow: /",
      "",
      "User-agent: OAI-SearchBot",
      "Allow: /",
      "",
      "User-agent: GPTBot",
      "Disallow: /",
      "",
      `Sitemap: ${absoluteUrl("/sitemap.xml",)}`,
      "",
    ].join("\n",),
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    },
  );
}
