import { Router } from "express";
import { fulfillSslCommerzByValId } from "../payments/fulfill-sslcommerz";
import { handleSslCommerzBrowserReturn } from "../payments/sslcommerz/sslcommerz-browser-handler";

const browserRouter = Router();

browserRouter.get("/browser-return", async (req, res, next) => {
  try {
    const q = req.query as Record<string, string | string[] | undefined>;
    const { redirect } = await handleSslCommerzBrowserReturn(q);
    res.redirect(302, redirect);
  } catch (e) {
    next(e);
  }
});

const ipnRouter = Router();

ipnRouter.post("/ipn", async (req, res) => {
  try {
    const body = req.body as Record<string, string | undefined>;
    const status = (body.status ?? "").toUpperCase();
    const tranId = body.tran_id ?? "";
    const valId = body.val_id ?? "";
    if (status === "VALID" && tranId && valId) {
      await fulfillSslCommerzByValId({ tranId, valId });
    }
  } catch (e) {
    console.error("[sslcommerz ipn]", e);
  }
  res.status(200).send("OK");
});

export { browserRouter as sslCommerzBrowserRouter, ipnRouter as sslCommerzIpnRouter };
