export default async function handler(request, response) {
  try {
    const { url } = request.query;

    if (!url) return response.status(400).json({ error: "Missing URL." });

    let startUrl;
    try {
      startUrl = new URL(url);
    } catch {
      return response.status(400).json({ error: "Invalid URL. Use https://example.com" });
    }

    const maxPages = 10;
    const visited = new Set();
    const queue = [startUrl.href];
    const pages = [];

    while (queue.length > 0 && pages.length < maxPages) {
      const currentUrl = queue.shift();
      if (visited.has(currentUrl)) continue;

      visited.add(currentUrl);

      const page = await crawlPage(currentUrl, startUrl.hostname);
      pages.push(page);

      page.links.forEach(link => {
        if (!visited.has(link) && queue.length + pages.length < maxPages) {
          queue.push(link);
        }
      });
    }

    const pageUrls = new Set(pages.map(page => page.url));

    const edges = [];

    pages.forEach(page => {
      page.links.forEach(link => {
        if (pageUrls.has(link)) {
          edges.push({
            from: page.url,
            to: link
          });
        }
      });
    });

    return response.status(200).json({
      crawledUrl: startUrl.href,
      pagesCrawled: pages.length,
      linksFound: [...new Set(pages.flatMap(page => page.links))].length,
      pages,
      edges
    });

  } catch (error) {
    return response.status(500).json({
      error: "Crawler failed.",
      details: error.message
    });
  }
}

async function crawlPage(pageUrl, rootHostname) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const siteResponse = await fetch(pageUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent": "AudiianceBot/0.3"
      }
    });

    clearTimeout(timeout);

    const html = await siteResponse.text();

    const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
    const title = titleMatch
      ? titleMatch[1].replace(/\s+/g, " ").trim()
      : "Untitled page";

    const matches = [...html.matchAll(/<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/gi)];

    const links = [];

    matches.forEach(match => {
      const href = match[2];

      if (
        !href ||
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("javascript:")
      ) return;

      try {
        const absoluteUrl = new URL(href, pageUrl);

        if (absoluteUrl.hostname === rootHostname) {
          absoluteUrl.hash = "";
          links.push(absoluteUrl.href);
        }
      } catch {}
    });

    return {
      url: pageUrl,
      title,
      statusCode: siteResponse.status,
      status: siteResponse.status >= 400 ? "Broken" : "Detected",
      suggestedEvent: suggestEvent(pageUrl),
      links: [...new Set(links)].slice(0, 25)
    };

  } catch {
    return {
      url: pageUrl,
      title: "Failed to crawl",
      statusCode: 0,
      status: "Failed",
      suggestedEvent: suggestEvent(pageUrl),
      links: []
    };
  }
}

function suggestEvent(rawUrl) {
  const value = rawUrl.toLowerCase();

  if (value.includes("contact")) return "generate_lead";
  if (value.includes("pricing")) return "view_pricing";
  if (value.includes("checkout")) return "begin_checkout";
  if (value.includes("cart")) return "view_cart";
  if (value.includes("blog")) return "view_article";
  if (value.includes("product")) return "view_item";
  if (value.includes("thank")) return "generate_lead";
  if (value.includes("demo")) return "generate_lead";
  if (value.includes("book")) return "generate_lead";

  return "page_view";
}
