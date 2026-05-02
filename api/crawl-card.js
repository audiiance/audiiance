export default async function handler(request, response) {
  try {
    const { url } = request.query;

    if (!url) {
      return response.status(400).json({
        error: "Missing URL. Add ?url=https://example.com/page"
      });
    }

    let targetUrl;

    try {
      targetUrl = new URL(url);
    } catch {
      return response.status(400).json({
        error: "Invalid URL. Use a full URL like https://example.com/page"
      });
    }

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
      return response.status(400).json({
        error: "Only http and https URLs are allowed."
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    const siteResponse = await fetch(targetUrl.href, {
      signal: controller.signal,
      headers: {
        "User-Agent": "AudiianceFunnelBot/1.0"
      }
    });

    clearTimeout(timeout);

    const html = await siteResponse.text();

    const title = extractTitle(html);
    const internalLinks = extractInternalLinks(html, targetUrl);
    const suggestedEvent = suggestEvent(targetUrl.href);

    return response.status(200).json({
      url: normalizeUrl(targetUrl.href),
      title,
      statusCode: siteResponse.status,
      status: siteResponse.status >= 400 ? "Broken" : "Detected",
      internalLinksCount: internalLinks.length,
      internalLinks,
      suggestedEvent
    });
  } catch (error) {
    return response.status(500).json({
      error: "Could not crawl this URL.",
      details: error.message
    });
  }
}

function extractTitle(html) {
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);

  if (!titleMatch) {
    return "Untitled page";
  }

  return decodeHtml(titleMatch[1])
    .replace(/\s+/g, " ")
    .trim();
}

function extractInternalLinks(html, targetUrl) {
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
      const absoluteUrl = new URL(href, targetUrl.href);

      if (absoluteUrl.hostname === targetUrl.hostname) {
        internalLinks.push(normalizeUrl(absoluteUrl.href));
      }
    } catch {
      // Ignore invalid links
    }
  });

  return [...new Set(internalLinks)];
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

  if (value.includes("thank") || value.includes("confirmation") || value.includes("order")) {
    return "purchase";
  }

  if (value.includes("checkout")) {
    return "begin_checkout";
  }

  if (value.includes("cart")) {
    return "add_to_cart";
  }

  if (value.includes("pricing")) {
    return "view_pricing";
  }

  if (value.includes("product")) {
    return "view_item";
  }

  if (value.includes("contact")) {
    return "generate_lead";
  }

  if (value.includes("demo")) {
    return "request_demo";
  }

  if (value.includes("book")) {
    return "book_appointment";
  }

  if (value.includes("download")) {
    return "file_download";
  }

  if (value.includes("search")) {
    return "search";
  }

  if (value.includes("signup") || value.includes("sign-up") || value.includes("register")) {
    return "sign_up";
  }

  if (value.includes("login") || value.includes("sign-in")) {
    return "login";
  }

  return "page_view";
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}
