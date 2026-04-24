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
    const queue = [normalizeUrl(startUrl.href)];
    const pages = [];
    const edges = [];

    while (queue.length > 0 && pages.length < maxPages) {
      const currentUrl = queue.shift();

      if (visited.has(currentUrl)) continue;
      visited.add(currentUrl);

      const pageData = await crawlPage(currentUrl, startUrl.hostname);
      const diagnosedPage = diagnosePage(pageData);
      pages.push(diagnosedPage);

      diagnosedPage.links.forEach(link => {
        edges.push({ from: currentUrl, to: link });

        if (!visited.has(link) && queue.length + pages.length < maxPages) {
          queue.push(link);
        }
      });
    }

    const crawledUrls = new Set(pages.map(page => page.url));

    const filteredEdges = edges.filter(edge =>
      crawledUrls.has(edge.from) && crawledUrls.has(edge.to)
    );

    const summary = buildSummary(pages, filteredEdges);

    return response.status(200).json({
      crawledUrl: normalizeUrl(startUrl.href),
      pagesCrawled: pages.length,
      pages,
      edges: filteredEdges,
      linksFound: [...new Set(pages.flatMap(page => page.links))].length,
      summary
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
        "User-Agent": "AudiianceBot/0.4"
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

function diagnosePage(page) {
  const pageType = detectPageType(page.url);
  const outboundCount = page.links.length;

  let riskLevel = "Low";
  let issue = "No major issue detected.";
  let recommendation = "Keep this page monitored as part of the sitemap.";

  if (page.status === "Failed") {
    riskLevel = "High";
    issue = "Crawler could not access this page.";
    recommendation = "Check whether this page blocks crawlers, requires authentication, or has server issues.";
  } else if (page.status === "Broken" || page.statusCode >= 400) {
    riskLevel = "High";
    issue = "This page returned an error status.";
    recommendation = "Fix the page, redirect it, or remove links pointing to it.";
  } else if (outboundCount === 0) {
    riskLevel = "Medium";
    issue = "This page appears to be a dead end.";
    recommendation = "Add clear next steps, internal links, or conversion paths.";
  } else if (pageType === "Conversion") {
    riskLevel = "Medium";
    issue = "This looks like a conversion-intent page.";
    recommendation = "Prioritize GA4 event tracking and CTA measurement here.";
  } else if (pageType === "Commerce") {
    riskLevel = "Medium";
    issue = "This looks like a commerce or purchase-path page.";
    recommendation = "Track product, cart, checkout, and purchase-intent events.";
  } else if (pageType === "Content") {
    riskLevel = "Low";
    issue = "This looks like a content page.";
    recommendation = "Track scroll depth, article engagement, and CTA clicks.";
  } else if (outboundCount > 20) {
    riskLevel = "Medium";
    issue = "This page has many outbound internal links.";
    recommendation = "Review whether users have too many choices or unclear next steps.";
  }

  return {
    ...page,
    pageType,
    riskLevel,
    issue,
    recommendation
  };
}

function buildSummary(pages, edges) {
  const highRisk = pages.filter(page => page.riskLevel === "High").length;
  const mediumRisk = pages.filter(page => page.riskLevel === "Medium").length;
  const deadEnds = pages.filter(page => page.links.length === 0).length;
  const conversionPages = pages.filter(page => page.pageType === "Conversion").length;

  return {
    highRisk,
    mediumRisk,
    deadEnds,
    conversionPages,
    connections: edges.length,
    healthScore: Math.max(0, 100 - highRisk * 20 - mediumRisk * 8 - deadEnds * 5)
  };
}

function detectPageType(rawUrl) {
  const value = rawUrl.toLowerCase();

  if (
    value.includes("contact") ||
    value.includes("thank") ||
    value.includes("demo") ||
    value.includes("book") ||
    value.includes("lead") ||
    value.includes("quote")
  ) {
    return "Conversion";
  }

  if (
    value.includes("checkout") ||
    value.includes("cart") ||
    value.includes("product") ||
    value.includes("shop") ||
    value.includes("pricing")
  ) {
    return "Commerce";
  }

  if (
    value.includes("blog") ||
    value.includes("article") ||
    value.includes("news") ||
    value.includes("guide") ||
    value.includes("resources")
  ) {
    return "Content";
  }

  return "General";
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
