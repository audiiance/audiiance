export default async function handler(request, response) {
  try {
    const { url } = request.query;

    if (!url) {
      return response.status(400).json({ error: "Missing URL. Add ?url=https://example.com" });
    }

    let startUrl;

    try {
      startUrl = new URL(url);
    } catch {
      return response.status(400).json({ error: "Invalid URL. Use full URL like https://example.com" });
    }

    if (!["http:", "https:"].includes(startUrl.protocol)) {
      return response.status(400).json({ error: "Only http and https URLs are allowed." });
    }

    const maxPages = 12;
    const visited = new Set();
    const queue = [startUrl.href];
    const pages = [];
    const edges = [];

    while (queue.length > 0 && pages.length < maxPages) {
      const currentUrl = queue.shift();

      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      const pageData = await crawlPage(currentUrl, startUrl.hostname);
      pages.push(pageData);

      pageData.links.forEach(link => {
        edges.push({
          from: currentUrl,
          to: link
        });

        if (!visited.has(link) && queue.length + pages.length < maxPages) {
          queue.push(link);
        }
      });
    }

    const crawledUrls = new Set(pages.map(page => page.url));

    const filteredEdges = edges.filter(edge =>
      crawledUrls.has(edge.from) && crawledUrls.has(edge.to)
    );

    return response.status(200).json({
      crawledUrl: startUrl.href,
      pagesCrawled: pages.length,
      pages,
      edges: filteredEdges,
      linksFound: [...new Set(pages.flatMap(page => page.links))].length
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

    const linkMatches = [...html.matchAll(/<a\s+(?:[^>]*?\s+)?href=(["'])(.*?)\1/gi)];
    const internalLinks = [];

    linkMatches.forEach(match => {
      const href = match[2];

      if (
        !href ||
        href.startsWith("#") ||
        href.startsWith("mailto:") ||
        href.startsWith("tel:") ||
        href.startsWith("javascript:")
      ) {
        return;
      }

      try {
        const absoluteUrl = new URL(href, pageUrl);

        if (absoluteUrl.hostname === rootHostname) {
          absoluteUrl.hash = "";
          internalLinks.push(normalizeUrl(absoluteUrl.href));
        }
      } catch {
        // Ignore bad hrefs
      }
    });

    return {
      url: normalizeUrl(pageUrl),
      statusCode: siteResponse.status,
      title,
      links: [...new Set(internalLinks)].slice(0, 25),
      suggestedEvent: suggestEvent(pageUrl),
      status: siteResponse.status >= 400 ? "Broken" : "Detected"
    };

  } catch {
    return {
      url: normalizeUrl(pageUrl),
      statusCode: 0,
      title: "Failed to crawl",
      links: [],
      suggestedEvent: suggestEvent(pageUrl),
      status: "Failed"
    };
  }
}

function normalizeUrl(rawUrl) {
  const url = new URL(rawUrl);
  url.hash = "";

  if (url.pathname !== "/" && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.href;
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
