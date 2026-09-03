import express, { Router } from "express";
import { stripeWebhookHandler } from "./stripe-webhook";
import {
  sslCommerzBrowserRouter,
  sslCommerzIpnRouter,
} from "./sslcommerz-callbacks.routes";

const router = Router();

/**
 * Stripe Webhook:
 * Requires raw JSON buffer for HMAC signature verification.
 */
router.post(
  "/webhooks/stripe",
  express.raw({ type: "application/json" }),
  (req, res, next) => {
    stripeWebhookHandler(req, res).catch(next);
  }
);

/**
 * SSLCommerz IPN (Instant Payment Notification):
 * Sent by SSLCommerz as application/x-www-form-urlencoded POST.
 */
router.use(
  "/webhooks/payments/sslcommerz",
  express.urlencoded({ extended: false }),
  sslCommerzIpnRouter
);

/**
 * SSLCommerz Browser Return:
 * SSLCommerz may GET-redirect or POST form data to success/fail/cancel URLs.
 */
router.use(
  "/payments/sslcommerz",
  express.urlencoded({ extended: false }),
  sslCommerzBrowserRouter
);

export { router as webhookRouter };
