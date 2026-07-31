import { Router } from "express";
import { nubraApi, getSessionToken } from "../nubra.js";
import { validate, orderPlaceSchema, orderCancelSchema } from "../validation.js";

const router = Router();

router.post("/place", validate(orderPlaceSchema), async (req, res) => {
  const { isMultiLeg, qty, side, deliveryType, priceType, validityType, entryPrice, legs, stratTags } = req.body;
  const refId = isMultiLeg ? null : req.body.refId || 1500001;

  try {
    const token = getSessionToken();
    if (!token) return res.status(401).json({ error: "No active broker session" });

    const orderPayload: any = {
      isMultiLeg: !!isMultiLeg,
      qty: parseInt(qty, 10),
      side: side || "BUY",
      deliveryType: deliveryType || "IDAY",
      priceType: priceType || "LIMIT",
      validityType: validityType || "DAY",
      executionMode: req.body.executionMode || "ENTRY",
    };

    if (!isMultiLeg) {
      orderPayload.refId = parseInt(refId as any, 10);
      if (entryPrice) orderPayload.entryPrice = parseInt(entryPrice, 10);
    } else {
      orderPayload.legs = legs;
      if (entryPrice) orderPayload.entryPrice = parseInt(entryPrice, 10);
    }

    if (stratTags) orderPayload.stratTags = stratTags;

    const orderRes = await nubraApi.createOrder([orderPayload]);
    res.json({ success: true, message: "Order placed successfully.", brokerResponse: orderRes });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/cancel", validate(orderCancelSchema), async (req, res) => {
  const { orderId } = req.body;
  try {
    const token = getSessionToken();
    if (!token) return res.status(401).json({ error: "No active broker session" });

    const brokerRes = await nubraApi.cancelOrder([{ orderId: parseInt(orderId, 10) }]);
    res.json({ success: true, message: "Order cancelled successfully.", brokerResponse: brokerRes });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    const token = getSessionToken();
    if (!token) return res.status(401).json({ error: "No active broker session" });

    const brokerOrders = await nubraApi.getOrders();
    res.json({
      success: true,
      orders: {
        open: brokerOrders?.orders?.open || [],
        executed: brokerOrders?.orders?.executed || [],
        cancelled: brokerOrders?.orders?.cancelled || [],
        rejected: brokerOrders?.orders?.rejected || [],
        gtt: brokerOrders?.orders?.gtt || [],
        expired: brokerOrders?.orders?.expired || [],
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
