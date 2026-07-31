import { Router } from "express";
import { nubraLogin, nubraSendOtp, nubraVerifyOtp, getLoginState } from "../nubra.js";
import { validate, sendOtpSchema, verifyOtpSchema } from "../validation.js";

const router = Router();

router.get("/status", (req, res) => {
  res.json(getLoginState());
});

router.post("/login", async (req, res) => {
  const token = await nubraLogin();
  if (token) {
    res.json({ success: true, token, state: getLoginState() });
  } else {
    res.status(401).json({ success: false, error: getLoginState().error });
  }
});

router.post("/send-otp", validate(sendOtpSchema), async (req, res) => {
  const result = await nubraSendOtp(req.body.phone);
  if (result.success) {
    res.json({ success: true, tempToken: result.tempToken });
  } else {
    res.status(400).json({ success: false, error: result.error });
  }
});

router.post("/verify-otp", validate(verifyOtpSchema), async (req, res) => {
  const { otp, tempToken, phone } = req.body;
  const result = await nubraVerifyOtp(otp, tempToken, phone);
  if (result.success) {
    res.json({ success: true, token: result.token, state: getLoginState() });
  } else {
    res.status(401).json({ success: false, error: result.error });
  }
});

export default router;
