import { Buffer } from "buffer";
import { handleGenerateTheme } from "./generate-theme.ts";
import { handleGenerateOpenAITheme } from "./generate-theme_openai.ts";
import { handleLyricProxy } from "./lyric-proxy.ts";
import { handleSegmentLyrics } from "./segment-lyrics.ts";
import { QQ_API_PREFIX, type QqServerlessEnv, handleQq } from "./qq.ts";

// qq-music-api uses Buffer during requests; Workers do not expose it without nodejs_compat.
// 这一行在模块作用域，所以它先于 fetch handler 与下面导出的 Durable Object 具现化执行 ——
// MQTT codec 也用 Buffer，DO 和入口在同一个 bundle、同一个 isolate 里。
(globalThis as typeof globalThis & { Buffer: typeof Buffer }).Buffer = Buffer;

/**
 * QQ 扫码登录通道的 Durable Object。
 *
 * 导出它本身不产生任何绑定或迁移：没有在 `wrangler.jsonc` 里配 binding 的部署，这就是一个用不到的
 * 导出，`/login/channels` 也只会宣告微信。想要这条通道的人自己加 binding，理由见 `qq.ts`。
 */
export { QqQrChannel } from "./qqQrChannel.ts";

const KUGOU_API_PREFIX = "/api/kugou";
const DEFAULT_KUGOU_API_ORIGIN = "https://ku-gou-music-api-chi-two.vercel.app";

type Env = {
  ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
  KUGOU_API_ORIGIN?: string;
  AI_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  OPENAI_API_KEY?: string;
  OPENAI_API_URL?: string;
  OPENAI_API_MODEL?: string;
  OPENAI_API_TEMPERATURE?: string;
} & QqServerlessEnv;

/**
 * 酷狗没有内置 serverless 运行时，这里把 `/api/kugou/*` 反向代理到独立部署的 KuGouMusicApi。
 * 同源请求既避开跨域，也让国内网络不必直连 *.vercel.app。
 */
async function handleKugouProxy(request: Request, env: Env): Promise<Response> {
  const origin = (env.KUGOU_API_ORIGIN || DEFAULT_KUGOU_API_ORIGIN).replace(/\/+$/, "");
  const url = new URL(request.url);
  const path = url.pathname.slice(KUGOU_API_PREFIX.length) || "/";
  const headers = new Headers(request.headers);
  headers.delete("host");
  return fetch(`${origin}${path}${url.search}`, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? null : request.body,
    redirect: "manual",
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/generate-theme") {
      return handleGenerateTheme(request, env);
    }

    if (url.pathname === "/api/generate-theme_openai") {
      return handleGenerateOpenAITheme(request, env);
    }

    if (url.pathname === "/api/lyric-proxy") {
      return handleLyricProxy(request);
    }

    if (url.pathname === "/api/segment-lyrics") {
      return handleSegmentLyrics(request, env);
    }

    // 酷狗路由同样自己兜住异常，避免代理失败把整站带下去。
    if (url.pathname === KUGOU_API_PREFIX || url.pathname.startsWith(`${KUGOU_API_PREFIX}/`)) {
      try {
        return await handleKugouProxy(request, env);
      } catch (error) {
        console.error("[worker] kugou proxy route failed:", error);
        return new Response(
          JSON.stringify({ code: 502, message: "KuGou API proxy failed" }),
          { status: 502, headers: { "content-type": "application/json; charset=utf-8" } },
        );
      }
    }

    // QQ 路由必须自己兜住异常：这个 worker 同时负责静态资源与既有三条 API，
    // 让它整个 throw 会把整站一起带下去，所以失败降级成 502 而不是向上冒泡。
    if (url.pathname === QQ_API_PREFIX || url.pathname.startsWith(`${QQ_API_PREFIX}/`)) {
      try {
        return await handleQq(request, env);
      } catch (error) {
        console.error("[worker] qq serverless route failed:", error);
        return new Response(
          JSON.stringify({ code: 502, message: "QQ serverless route failed" }),
          { status: 502, headers: { "content-type": "application/json; charset=utf-8" } },
        );
      }
    }

    return env.ASSETS.fetch(request);
  },
};
