interface Env {
    BROWSER: BrowserRun;
}

const ALLOWED_HOSTNAMES = new Set([
    "silenth.ca",
    "www.silenth.ca",
]);

const RENDERABLE_PATHS = new Set([
    "/",
    "/menu",
    "/events",
    "/story",
]);

const BOT_USER_AGENTS =
    /googlebot|google-inspectiontool|bingbot|slurp|duckduckbot|baiduspider|yandexbot|facebookexternalhit|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|whatsapp|applebot|gptbot|chatgpt-user|oai-searchbot|claudebot|claude-user|perplexitybot|ccbot|bytespider/i;

function normalizePath(pathname: string): string {
    if (pathname.length > 1 && pathname.endsWith("/")) {
        return pathname.slice(0, -1);
    }

    return pathname;
}

function isAssetRequest(pathname: string): boolean {
    return (
        pathname.startsWith("/assets/") ||
        /\.(js|css|png|jpg|jpeg|webp|svg|gif|ico|mp4|webm|woff|woff2|ttf|map|xml|txt)$/i.test(
            pathname,
        )
    );
}

function isBotRequest(request: Request): boolean {
    const userAgent = request.headers.get("user-agent") || "";
    return BOT_USER_AGENTS.test(userAgent);
}

function isRenderableHtmlRequest(request: Request, url: URL): boolean {
    if (request.method !== "GET") return false;
    if (isAssetRequest(url.pathname)) return false;

    const normalizedPath = normalizePath(url.pathname);
    if (!RENDERABLE_PATHS.has(normalizedPath)) return false;

    const accept = request.headers.get("accept") || "";

    return (
        accept.includes("text/html") ||
        accept.includes("*/*") ||
        accept === ""
    );
}

async function renderHtml(env: Env, targetUrl: URL): Promise<string> {
    const response = await env.BROWSER.quickAction("content", {
        url: targetUrl.toString(),
        gotoOptions: {
            waitUntil: "networkidle2",
            timeout: 30000,
        },
        waitForSelector: {
            selector: "#root main",
            timeout: 30000,
        },
    });

    if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new Error(`Browser Run failed with ${response.status}: ${detail}`);
    }

    const data = (await response.json()) as {
        success: boolean;
        result?: string;
    };

    if (!data.success || typeof data.result !== "string") {
        throw new Error("Browser Run returned an unsuccessful response");
    }

    return data.result;
}

async function handleManualPrerender(request: Request, env: Env): Promise<Response> {
    const requestUrl = new URL(request.url);
    const target = requestUrl.searchParams.get("url");

    if (!target) {
        return Response.json(
            { error: "Missing url parameter" },
            { status: 400 },
        );
    }

    const targetUrl = new URL(target);

    if (!["http:", "https:"].includes(targetUrl.protocol)) {
        return Response.json(
            { error: "Only HTTP and HTTPS URLs are allowed" },
            { status: 400 },
        );
    }

    if (!ALLOWED_HOSTNAMES.has(targetUrl.hostname)) {
        return Response.json(
            { error: "Hostname not allowed" },
            { status: 400 },
        );
    }

    const html = await renderHtml(env, targetUrl);

    return new Response(html, {
        headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "x-silent-h-prerender": "manual",
        },
    });
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === "/__prerender") {
            return handleManualPrerender(request, env);
        }

        if (!ALLOWED_HOSTNAMES.has(url.hostname)) {
            return fetch(request);
        }

        if (!isBotRequest(request) || !isRenderableHtmlRequest(request, url)) {
            return fetch(request);
        }

        const normalizedPath = normalizePath(url.pathname);

        const cacheUrl = new URL(request.url);
        cacheUrl.pathname = `/__prerender-cache${normalizedPath}`;
        cacheUrl.search = "";

        const cacheKey = new Request(cacheUrl.toString(), request);
        const cache = caches.default;

        const cached = await cache.match(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const html = await renderHtml(env, url);

            const response = new Response(html, {
                headers: {
                    "content-type": "text/html; charset=utf-8",
                    "cache-control": "public, max-age=21600",
                    "x-silent-h-prerender": "hit",
                },
            });

            await cache.put(cacheKey, response.clone());

            return response;
        } catch {
            return fetch(request);
        }
    },
} satisfies ExportedHandler<Env>;