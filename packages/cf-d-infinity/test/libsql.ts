// @libsql/client を、シミュレータにつなぐ。本物のクライアントが送る要求 (batch の条件、baton) を、そのまま試すためにある。
import { createClient, type Client } from "@libsql/client";
import { Db } from "../src/client/db";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import type { SimCluster } from "./sim";

/** @libsql/client の HTTP を、シミュレータの Hrana の入口へつなぐ。 */
export function clientOf(c: SimCluster): Client {
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && (path === "/v2" || path === "/v3")) return new Response(null, { status: 200 });
    if (req.method === "POST" && (path === "/v2/pipeline" || path === "/v3/pipeline")) {
      const body = (await req.json()) as PipelineReq;
      return Response.json(await handlePipeline(body, async (token) => new Db(c, { token })));
    }
    return new Response("not found", { status: 404 });
  };
  return createClient({ url: "http://sim", fetch: fetch as never });
}

