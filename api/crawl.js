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
      pages.push(pageData);

      pageData.links.forEach(link => {
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

    const diagnosedPages = pages.map(page => diagnosePage(page));

    const summary = buildSummary(diagnosedPages, filteredEdges);

    return response.status(200).json({
      crawledUrl: normalizeUrl(startUrl.href),
      pagesCrawled: diagnosedPages.length,
      linksFound: [...new Set(pages.flatMap(page => page.links))].length,
      edges: filteredEdges,
      summary,
      pages: diagnosedPages
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
  const url = page.url.toLowerCase();
  const linkCount = page.links.length;

  let pageType = "Standard Page";
  let diagnosis = "Healthy";
  let riskLevel = "Low";
  let issue = "No major issue detected.";
  let recommendation = "Keep this page monitored as part of the sitemap.";
  let priority = "Low";

  if (page.status === "Failed" || page.statusCode === 0) {
    diagnosis = "Failed";
    riskLevel = "High";
    issue = "The crawler could not access this page.";
    recommendation = "Check whether the page blocks bots, requires JavaScript, or has server/network restrictions.";
    priority = "High";
  } else if (page.statusCode >= 400) {
    diagnosis = "Broken";
    riskLevel = "High";
    issue = "This page returned an error status.";
    recommendation = "Fix the page, update internal links, or add a redirect.";
    priority = "High";
  } else if (
    url.includes("contact") ||
    url.includes("thank") ||
    url.includes("demo") ||
    url.includes("book") ||
    url.includes("checkout") ||
    url.includes("cart") ||
    url.includes("pricing")
  ) {
    diagnosis = "Opportunity";
    riskLevel = "Medium";
    issue = "This looks like a high-intent page.";
    recommendation = "Prioritize GA4 event tracking and CTA measurement here.";
    priority = "High";
  } else if (linkCount === 0) {
    diagnosis = "Dead End";
    riskLevel = "Medium";
    issue = "This page has no detected internal outbound links.";
    recommendation = "Check whether users have a clear next step from this page.";
    priority = "Medium";
  } else if (linkCount > 20) {
    diagnosis = "Dense Page";
    riskLevel = "Medium";
    issue = "This page has many internal links.";
    recommendation = "Review whether the page creates too many navigation choices.";
    priority = "Medium";
  }

  if (url.includes("pricing")) pageType = "Pricing Page";
  else if (url.includes("contact")) pageType = "Contact Page";
  else if (url.includes("checkout")) pageType = "Checkout Page";
  else if (url.includes("cart")) pageType = "Cart Page";
  else if (url.includes("thank")) pageType = "Thank You Page";
  else if (url.includes("blog") || url.includes("article")) pageType = "Content Page";
  else if (url.includes("product")) pageType = "Product Page";
  else if (new URL(page.url).pathname === "/") pageType = "Homepage";

  return {
    ...page,
    pageType,
    diagnosis,
    riskLevel,
    issue,
    recommendation,
    priority
  };
}

function buildSummary(pages, edges) {
  return {
    totalPages: pages.length,
    totalEdges: edges.length,
    healthy: pages.filter(page => page.diagnosis === "Healthy").length,
    opportunities: pages.filter(page => page.diagnosis === "Opportunity").length,
    broken: pages.filter(page => page.diagnosis === "Broken").length,
    failed: pages.filter(page => page.diagnosis === "Failed").length,
    deadEnds: pages.filter(page => page.diagnosis === "Dead End").length,
    densePages: pages.filter(page => page.diagnosis === "Dense Page").length
  };
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
