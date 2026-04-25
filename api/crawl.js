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
    const priorityQueue = buildPriorityQueue(diagnosedPages, filteredEdges);
    const summary = buildSummary(diagnosedPages, filteredEdges, priorityQueue);

    return response.status(200).json({
      crawledUrl: normalizeUrl(startUrl.href),
      pagesCrawled: diagnosedPages.length,
      linksFound: [...new Set(pages.flatMap(page => page.links))].length,
      edges: filteredEdges,
      summary,
      priorityQueue,
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
        "User-Agent": "AudiianceBot/0.6"
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

  let pageType = detectPageType(page.url);
  let diagnosis = "Healthy";
  let issue = "No major issue detected.";
  let recommendation = "Keep this page monitored as part of the sitemap.";

  if (page.status === "Failed" || page.statusCode === 0) {
    diagnosis = "Failed";
    issue = "The crawler could not access this page.";
    recommendation = "Check whether the page blocks bots, requires JavaScript, or has server/network restrictions.";
  } else if (page.statusCode >= 400) {
    diagnosis = "Broken";
    issue = "This page returned an error status.";
    recommendation = "Fix the page, update internal links, or add a redirect.";
  } else if (isHighIntentUrl(url)) {
    diagnosis = "Opportunity";
    issue = "This looks like a high-intent page.";
    recommendation = "Prioritize GA4 event tracking, CTA measurement, and conversion path review here.";
  } else if (linkCount === 0) {
    diagnosis = "Dead End";
    issue = "This page has no detected internal outbound links.";
    recommendation = "Add clear next-step links, CTAs, or navigation paths from this page.";
  } else if (linkCount > 20) {
    diagnosis = "Dense Page";
    issue = "This page has many internal links.";
    recommendation = "Review whether the page creates too many navigation choices.";
  }

  const priorityScore = calculatePriorityScore({
    ...page,
    pageType,
    diagnosis
  });

  const priorityLevel = getPriorityLevel(priorityScore);

  const actionCard = buildActionCard({
    ...page,
    pageType,
    diagnosis,
    issue,
    recommendation,
    priorityScore,
    priorityLevel
  });

  const actionBoard = buildActionBoardMetadata({
    ...page,
    pageType,
    diagnosis,
    priorityScore,
    priorityLevel
  });

  return {
    ...page,
    pageType,
    diagnosis,
    issue,
    recommendation,
    priority: priorityLevel,
    priorityScore,
    priorityLevel,
    actionCard,
    actionBoard
  };
}

function calculatePriorityScore(page) {
  let score = 0;

  if (page.diagnosis === "Broken") score += 55;
  if (page.diagnosis === "Failed") score += 50;
  if (page.diagnosis === "Opportunity") score += 35;
  if (page.diagnosis === "Dead End") score += 30;
  if (page.diagnosis === "Dense Page") score += 25;

  if (page.pageType === "Pricing Page") score += 25;
  if (page.pageType === "Checkout Page") score += 25;
  if (page.pageType === "Contact Page") score += 20;
  if (page.pageType === "Product Page") score += 18;
  if (page.pageType === "Cart Page") score += 18;
  if (page.pageType === "Thank You Page") score += 16;
  if (page.pageType === "Homepage") score += 14;
  if (page.pageType === "Content Page") score += 8;

  if (page.statusCode >= 500) score += 20;
  else if (page.statusCode >= 400) score += 15;

  if (page.links.length === 0) score += 10;
  if (page.links.length > 20) score += 8;

  return Math.min(100, score);
}

function getPriorityLevel(score) {
  if (score >= 80) return "Critical";
  if (score >= 60) return "High";
  if (score >= 35) return "Medium";
  return "Low";
}

function buildActionCard(page) {
  let whyItMatters = "This page contributes to the structure and discoverability of the website.";
  let howToFix = page.recommendation;

  if (page.diagnosis === "Broken") {
    whyItMatters = "Broken pages damage user trust, waste internal link equity, and can block important journeys.";
    howToFix = "Restore the page, correct the internal link, or redirect this URL to the most relevant working page.";
  }

  if (page.diagnosis === "Failed") {
    whyItMatters = "If Audiiance cannot access this page, users or search engines may also experience access problems.";
    howToFix = "Check server availability, bot blocking rules, JavaScript dependency, authentication, or timeout issues.";
  }

  if (page.diagnosis === "Opportunity") {
    whyItMatters = "High-intent pages are close to conversion and should be tracked, measured, and optimized first.";
    howToFix = "Add GA4/GTM event tracking, review the CTA, and confirm the next conversion step is clear.";
  }

  if (page.diagnosis === "Dead End") {
    whyItMatters = "Dead-end pages can stop users from continuing their journey through the website.";
    howToFix = "Add internal links to relevant next steps, such as contact, product, pricing, article, or homepage pages.";
  }

  if (page.diagnosis === "Dense Page") {
    whyItMatters = "Too many links can dilute attention and make it harder for users to choose the next best action.";
    howToFix = "Group links, reduce unnecessary navigation choices, and make the primary next action more obvious.";
  }

  return {
    title: `${page.priorityLevel} Priority: ${page.diagnosis}`,
    whatIsWrong: page.issue,
    whyItMatters,
    howToFix,
    suggestedEvent: page.suggestedEvent
  };
}

function buildActionBoardMetadata(page) {
  const category = getIssueCategory(page);
  const impact = getEstimatedImpact(page);
  const effort = getEstimatedEffort(page);
  const actionType = getActionType(page);
  const actionBucket = getActionBucket(page.priorityScore, impact, effort);

  return {
    category,
    impact,
    effort,
    fixStatus: "Open",
    actionType,
    actionBucket
  };
}

function getIssueCategory(page) {
  if (page.diagnosis === "Broken" || page.diagnosis === "Failed") return "Technical";
  if (page.diagnosis === "Opportunity") return "Conversion";
  if (page.diagnosis === "Dead End" || page.diagnosis === "Dense Page") return "Navigation";
  if (page.suggestedEvent && page.suggestedEvent !== "page_view") return "Tracking";
  return "General";
}

function getEstimatedImpact(page) {
  if (page.priorityScore >= 80) return "High";
  if (page.priorityScore >= 50) return "Medium";
  return "Low";
}

function getEstimatedEffort(page) {
  if (page.diagnosis === "Broken" || page.diagnosis === "Failed") return "High";
  if (page.diagnosis === "Dense Page") return "Medium";
  if (page.diagnosis === "Dead End") return "Low";
  if (page.diagnosis === "Opportunity") return "Medium";
  return "Low";
}

function getActionType(page) {
  if (page.diagnosis === "Broken") return "Fix broken page";
  if (page.diagnosis === "Failed") return "Investigate crawl failure";
  if (page.diagnosis === "Opportunity") return "Improve conversion tracking";
  if (page.diagnosis === "Dead End") return "Add next-step links";
  if (page.diagnosis === "Dense Page") return "Simplify navigation";
  return "Monitor page";
}

function getActionBucket(score, impact, effort) {
  if ((impact === "High" || score >= 70) && effort === "Low") return "Quick Win";
  if (impact === "High") return "High Impact";
  if (effort === "Low") return "Quick Win";
  return "Cleanup";
}

function buildPriorityQueue(pages, edges) {
  return pages
    .filter(page => page.priorityScore >= 35)
    .map(page => {
      const incomingLinks = edges.filter(edge => edge.to === page.url).length;
      const outgoingLinks = edges.filter(edge => edge.from === page.url).length;

      return {
        url: page.url,
        title: page.title,
        pageType: page.pageType,
        diagnosis: page.diagnosis,
        priorityScore: page.priorityScore,
        priorityLevel: page.priorityLevel,
        issue: page.issue,
        recommendation: page.recommendation,
        actionCard: page.actionCard,
        actionBoard: page.actionBoard,
        suggestedEvent: page.suggestedEvent,
        incomingLinks,
        outgoingLinks
      };
    })
    .sort((a, b) => {
      const bucketWeight = {
        "Quick Win": 3,
        "High Impact": 2,
        "Cleanup": 1
      };

      const aBucket = bucketWeight[a.actionBoard.actionBucket] || 0;
      const bBucket = bucketWeight[b.actionBoard.actionBucket] || 0;

      if (bBucket !== aBucket) return bBucket - aBucket;
      return b.priorityScore - a.priorityScore;
    });
}

function buildSummary(pages, edges, priorityQueue) {
  return {
    totalPages: pages.length,
    totalEdges: edges.length,
    healthy: pages.filter(page => page.diagnosis === "Healthy").length,
    opportunities: pages.filter(page => page.diagnosis === "Opportunity").length,
    broken: pages.filter(page => page.diagnosis === "Broken").length,
    failed: pages.filter(page => page.diagnosis === "Failed").length,
    deadEnds: pages.filter(page => page.diagnosis === "Dead End").length,
    densePages: pages.filter(page => page.diagnosis === "Dense Page").length,
    critical: pages.filter(page => page.priorityLevel === "Critical").length,
    high: pages.filter(page => page.priorityLevel === "High").length,
    medium: pages.filter(page => page.priorityLevel === "Medium").length,
    low: pages.filter(page => page.priorityLevel === "Low").length,
    actionableFixes: priorityQueue.length
  };
}

function detectPageType(rawUrl) {
  const url = rawUrl.toLowerCase();
  const path = new URL(rawUrl).pathname;

  if (path === "/") return "Homepage";
  if (url.includes("pricing")) return "Pricing Page";
  if (url.includes("contact")) return "Contact Page";
  if (url.includes("checkout")) return "Checkout Page";
  if (url.includes("cart")) return "Cart Page";
  if (url.includes("thank")) return "Thank You Page";
  if (url.includes("blog") || url.includes("article")) return "Content Page";
  if (url.includes("product")) return "Product Page";

  return "Standard Page";
}

function isHighIntentUrl(url) {
  return (
    url.includes("contact") ||
    url.includes("thank") ||
    url.includes("demo") ||
    url.includes("book") ||
    url.includes("checkout") ||
    url.includes("cart") ||
    url.includes("pricing")
  );
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
