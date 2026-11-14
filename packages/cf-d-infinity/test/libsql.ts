// @libsql/client を、シミュレータにつなぐ。本物のクライアントが送る要求 (batch の条件、baton) を、そのまま試すためにある。
import { createClient, type Client } from "@libsql/client";
import { Db } from "../src/client/db";
import { handlePipeline, type PipelineReq } from "../src/client/hrana";
import type { Reference } from "../src/sql/plan";
import type { SimCluster } from "./sim";

export interface ClientOptions {
  /**
   * 結果の INTEGER の返し方。"bigint" にすると、INTEGER は BigInt、REAL は JS の数で返るので、結果の型を見分けられる。
   * 既定 ("number") は、どちらも JS の数である。
   */
  intMode?: "number" | "bigint" | "string";
  /** 基準経路だけで実行する (src/sql/plan.ts の Reference)。指定しなければ、クラスタのもの (環境変数 REFERENCE) を使う。 */
  reference?: Reference;
}

/** @libsql/client の HTTP を、シミュレータの Hrana の入口へつなぐ。 */
export function clientOf(c: SimCluster, o: ClientOptions = {}): Client {
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : new Request(input, init);
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && (path === "/v2" || path === "/v3")) return new Response(null, { status: 200 });
    if (req.method === "POST" && (path === "/v2/pipeline" || path === "/v3/pipeline")) {
      const body = (await req.json()) as PipelineReq;
      return Response.json(await handlePipeline(body, async (token) => new Db(c, { token, reference: o.reference })));
    }
    return new Response("not found", { status: 404 });
  };
  return createClient({ url: "http://sim", fetch: fetch as never, intMode: o.intMode });
}
