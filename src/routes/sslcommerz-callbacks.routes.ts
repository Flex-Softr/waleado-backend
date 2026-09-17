import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { fulfillSslCommerzByValId } from "../payments/fulfill-sslcommerz";
import { handleSslCommerzBrowserReturn } from "../payments/sslcommerz/sslcommerz-browser-handler";

const browserRouter = Router();

/**
 * SSLCommerz often POSTs application/x-www-form-urlencoded to success_url; some flows use GET + query.
 */
function mergeBrowserReturnParams(
  req: Request
): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {
    ...(req.query as Record<string, string | string[] | undefined>),
  };
  const body = req.body;
  if (body && typeof body === "object" && !Buffer.isBuffer(body)) {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
      else if (Array.isArray(v) && typeof v[0] === "string") out[k] = v[0];
    }
  }
  return out;
}

async function browserReturnHandler(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const q = mergeBrowserReturnParams(req);
    const { redirect } = await handleSslCommerzBrowserReturn(q);
    res.redirect(303, redirect);
  } catch (e) {
    next(e);
  }
}

browserRouter.get("/browser-return", browserReturnHandler);
browserRouter.post("/browser-return", browserReturnHandler);

const ipnRouter = Router();

function ipnField(
  body: Record<string, unknown>,
  name: string
): string {
  const want = name.toLowerCase();
  for (const [k, v] of Object.entries(body)) {
    if (k.toLowerCase() !== want) continue;
    if (typeof v === "string") return v;
    if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  }
  return "";
}

ipnRouter.post("/ipn", async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    const status = ipnField(body, "status").toUpperCase();
    const tranId = ipnField(body, "tran_id");
    const valId = ipnField(body, "val_id");
    if (status === "VALID" && tranId && valId) {
      await fulfillSslCommerzByValId({ tranId, valId });
    }
  } catch (e) {
    console.error("[sslcommerz ipn]", e);
  }
  res.status(200).send("OK");
});

export { browserRouter as sslCommerzBrowserRouter, ipnRouter as sslCommerzIpnRouter };
