import React, { useState, useEffect } from "react";
import { ShieldCheck, ShieldAlert, RefreshCw, Landmark, AlertTriangle, Key, Clock, Smartphone, Send, XCircle } from "lucide-react";
import { PortfolioSummary } from "../types";

interface TerminalHeaderProps {
  loginState: {
    status: string;
    error: string;
    phone: string;
    deviceId: string;
    env: string;
    baseUrl: string;
  };
  portfolio: PortfolioSummary | null;
  onRefreshLogin: () => void;
  isRefreshingLogin: boolean;
}

export default function TerminalHeader({
  loginState,
  portfolio,
  onRefreshLogin,
  isRefreshingLogin,
}: TerminalHeaderProps) {
  const isConnected = loginState.status === "LOGGED_IN";

  const funds = portfolio?.funds?.portFundsAndMargin;
  const positions = portfolio?.positions?.portfolio;

  const totalFunds = funds ? funds.startOfDayFunds / 100 : 500000;
  const netMargin = funds ? funds.netMarginAvailable / 100 : 485000;
  const blockedMargin = funds ? funds.totalMarginBlocked / 100 : 15000;
  const dayPnl = positions ? positions.positionStats.totalPnl / 100 : 3500;

  const [currentTime, setCurrentTime] = useState<Date>(new Date());

  // OTP login state
  const [showOtpModal, setShowOtpModal] = useState(false);
  const [otpPhone, setOtpPhone] = useState(loginState.phone || "8447296129");
  const [otpSent, setOtpSent] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  const [otpTempToken, setOtpTempToken] = useState("");
  const [otpLoading, setOtpLoading] = useState(false);
  const [otpError, setOtpError] = useState("");

  const sendOtp = async () => {
    setOtpLoading(true);
    setOtpError("");
    try {
      const res = await fetch("/api/auth/send-otp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: otpPhone }),
      });
      const data = await res.json();
      if (data.success) {
        setOtpSent(true);
        setOtpTempToken(data.tempToken);
      } else {
        setOtpError(data.error || "Failed to send OTP");
      }
    } catch (e: any) {
      setOtpError(e.message);
    } finally {
      setOtpLoading(false);
    }
  };

  const verifyOtp = async () => {
    setOtpLoading(true);
    setOtpError("");
    try {
      const res = await fetch("/api/auth/verify-otp", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ otp: otpCode, tempToken: otpTempToken, phone: otpPhone }),
      });
      const data = await res.json();
      if (data.success) {
        window.location.reload();
      } else {
        setOtpError(data.error || "OTP verification failed");
      }
    } catch (e: any) {
      setOtpError(e.message);
    } finally {
      setOtpLoading(false);
    }
  };

  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // Determine market status (NSE: Mon-Fri 09:15 - 15:30 IST)
  const istTimeStr = currentTime.toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
  const istDate = new Date(istTimeStr);
  const day = istDate.getDay(); // 0 = Sun, 6 = Sat
  const hours = istDate.getHours();
  const minutes = istDate.getMinutes();
  const timeNum = hours * 100 + minutes;

  const isWeekday = day >= 1 && day <= 5;
  const isMarketHours = timeNum >= 915 && timeNum <= 1530;
  const isMarketOpen = isWeekday && isMarketHours;

  return (
    <header className="bg-brand-card border-b border-brand-border text-slate-100 py-3 px-4 md:px-6 z-20 shadow-md">
      <div className="w-full mx-auto flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 px-4">
        {/* Logo and Broker Status */}
        <div className="flex items-center gap-4">
          <div className="w-8 h-8 bg-white flex items-center justify-center rounded-sm shrink-0">
            <div className="w-4 h-4 bg-black rotate-45"></div>
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="font-serif text-lg italic font-bold tracking-tight text-white">Nubra Terminal</h1>
              <span className={`font-mono text-[10px] px-2 py-0.5 font-bold rounded ${
                loginState.env === "PROD" ? "bg-emerald-500/10 text-brand-green border border-emerald-500/20" : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
              }`}>
                {loginState.env}
              </span>
            </div>
            <div className="flex items-center gap-2 text-xs text-gray-500 mt-0.5">
              <span className="font-mono uppercase text-[10px]">OMS V3 Platform</span>
              <span className="text-white/10">•</span>
              <div className="flex items-center gap-1.5">
                {loginState.status === "LOGGED_IN" ? (
                  <span className="text-brand-green flex items-center gap-1 font-mono text-[10px] uppercase font-bold tracking-wider glow-green">
                    <span className="w-1.5 h-1.5 rounded-full bg-brand-green shadow-[0_0_8px_#00ff9d]"></span> Live Connected
                  </span>
                ) : loginState.status === "PENDING" ? (
                  <span className="text-indigo-400 flex items-center gap-1 font-mono text-[10px] uppercase font-bold tracking-wider animate-pulse">
                    <RefreshCw className="h-2.5 w-2.5 animate-spin" /> Authenticating...
                  </span>
                ) : (
                  <span className="text-brand-red flex items-center gap-1 font-mono text-[10px] uppercase font-bold tracking-wider glow-red">
                    <span className="w-1.5 h-1.5 rounded-full bg-brand-red shadow-[0_0_8px_#ff4b4b]"></span> Offline (Sim Mode)
                  </span>
                )}
              </div>
            </div>
            {/* Clock & Market Status Widget */}
            <div className="flex items-center gap-2 mt-1.5 text-[11px] font-mono text-gray-400">
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3 text-gray-400" />
                <span className="text-gray-300">
                  {currentTime.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })} IST
                </span>
              </div>
              <span className="text-white/20">•</span>
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase tracking-wider ${
                isMarketOpen 
                  ? "bg-emerald-500/10 text-brand-green border border-emerald-500/20" 
                  : "bg-amber-500/10 text-amber-400 border border-amber-500/20"
              }`}>
                <span className={`w-1.5 h-1.5 rounded-full ${isMarketOpen ? "bg-brand-green animate-pulse" : "bg-amber-400"}`}></span>
                {isMarketOpen ? "Market Open" : "Market Closed"}
              </span>
            </div>
          </div>
        </div>

        {/* Account Quick Metrics */}
        <div className="flex flex-wrap items-center gap-2 md:gap-4 bg-black/40 p-2 md:p-2.5 rounded border border-brand-border">
          <div className="px-3 border-r border-brand-border">
            <span className="block text-[9px] uppercase font-semibold text-gray-500 tracking-wider">Available Capital</span>
            <span className="font-mono text-sm md:text-base font-medium text-white">
              ₹{netMargin.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>

          <div className="px-3 border-r border-brand-border">
            <span className="block text-[9px] uppercase font-semibold text-gray-500 tracking-wider">Blocked Margin</span>
            <span className="font-mono text-sm md:text-base font-medium text-gray-400">
              ₹{blockedMargin.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>

          <div className="px-3 border-r border-brand-border">
            <span className="block text-[9px] uppercase font-semibold text-gray-500 tracking-wider">Day Realized P&L</span>
            <span className={`font-mono text-sm md:text-base font-bold ${dayPnl >= 0 ? "text-brand-green glow-green" : "text-brand-red glow-red"}`}>
              {dayPnl >= 0 ? "+" : ""}₹{dayPnl.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>

          <div className="px-3">
            <span className="block text-[9px] uppercase font-semibold text-gray-500 tracking-wider">Brokerage</span>
            <span className="font-mono text-xs text-gray-400">
              ₹{funds ? (funds.brokerage / 100).toFixed(2) : "120.00"}
            </span>
          </div>
        </div>

        {/* Credentials Status Control */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowOtpModal(true)}
            disabled={isConnected}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-semibold border tracking-wide uppercase transition-all duration-200 ${
              isConnected
                ? "bg-black/55 border-brand-border text-gray-500 cursor-default"
                : "bg-emerald-600 text-white hover:bg-emerald-500 border-transparent shadow"
            } disabled:opacity-50`}
          >
            <Smartphone className="h-3 w-3" />
            {isConnected ? "Connected" : "Login with OTP"}
          </button>

          <button
            onClick={onRefreshLogin}
            disabled={isRefreshingLogin}
            className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-semibold border tracking-wide uppercase transition-all duration-200 ${
              isConnected
                ? "bg-black/55 border-brand-border text-gray-300 hover:bg-white/5"
                : "bg-white text-black hover:bg-gray-100 border-transparent shadow"
            } disabled:opacity-50`}
          >
            <RefreshCw className={`h-3 w-3 ${isRefreshingLogin ? "animate-spin" : ""}`} />
            {isRefreshingLogin ? "Connecting..." : isConnected ? "Reconnect" : "TOTP Login"}
          </button>

          {/* Diagnostic Info tooltip / trigger */}
          <div className="group relative">
            <div className="cursor-pointer p-1.5 bg-black/45 border border-brand-border rounded hover:bg-white/5 text-gray-400">
              <Key className="h-3.5 w-3.5" />
            </div>
            <div className="absolute right-0 top-10 mt-1 w-72 bg-brand-card border border-brand-border p-4 rounded shadow-2xl invisible group-hover:visible transition-all duration-200 z-50">
              <div className="flex items-center gap-2 border-b border-brand-border pb-2 mb-2">
                <Landmark className="h-4 w-4 text-white/80" />
                <h4 className="font-serif italic text-xs text-white tracking-wider">Nubra Credentials</h4>
              </div>
              <ul className="space-y-2 text-[11px] font-mono text-gray-400">
                <li className="flex justify-between">
                  <span>Phone Number:</span>
                  <span className="text-gray-200">{loginState.phone || "8447296129"}</span>
                </li>
                <li className="flex justify-between">
                  <span>Device ID:</span>
                  <span className="text-gray-200">{loginState.deviceId || "NQ001"}</span>
                </li>
                <li className="flex justify-between">
                  <span>TOTP State:</span>
                  <span className="text-brand-green">Active (Auto)</span>
                </li>
                <li className="flex justify-between">
                  <span>API Base:</span>
                  <span className="text-gray-500 overflow-hidden text-ellipsis whitespace-nowrap max-w-[150px]">
                    {loginState.baseUrl}
                  </span>
                </li>
              </ul>
              {loginState.status === "FAILED" && (
                <div className="mt-3 space-y-2">
                  <div className="p-2 bg-brand-red/10 border border-brand-red/20 text-brand-red rounded text-[10px] flex items-start gap-1.5 leading-snug">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-brand-red" />
                    <span>
                      <strong>Connection Error:</strong> {loginState.error || "Login rejected by OMS V3."}
                    </span>
                  </div>
                  {loginState.error?.includes("TOTP is not enabled") && (
                    <div className="p-2.5 bg-indigo-500/10 border border-indigo-500/20 text-indigo-300 rounded text-[10px] leading-relaxed">
                      <p className="font-semibold text-white mb-1">🔧 How to activate TOTP:</p>
                      <ol className="list-decimal pl-3.5 space-y-1">
                        <li>Log in to your Nubra / Zanskar Securities web portal.</li>
                        <li>Go to <strong>Profile &gt; Security Settings</strong>.</li>
                        <li>Click <strong>Enable TOTP / Register Authenticator</strong>.</li>
                        <li>Provide the secret key from your <strong>Nubra security settings</strong> (configured in .env).</li>
                        <li>Submit a 6-digit code on their portal to complete activation.</li>
                      </ol>
                      <p className="mt-2 text-[9px] text-gray-400">
                        *Until activated on the broker side, the API rejects all logins. Terminal is currently running in <strong>high-fidelity offline simulator mode</strong> for you!
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* OTP Login Modal */}
      {showOtpModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl w-full max-w-md p-6 mx-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-white font-bold text-sm flex items-center gap-2">
                <Smartphone className="h-4 w-4 text-emerald-400" />
                Login via OTP
              </h3>
              <button onClick={() => { setShowOtpModal(false); setOtpSent(false); setOtpError(""); }} className="text-gray-500 hover:text-white transition-colors">
                <XCircle className="h-5 w-5" />
              </button>
            </div>

            {!otpSent ? (
              <div className="space-y-4">
                <div>
                  <label className="block text-[11px] text-gray-400 font-mono mb-1">Phone Number</label>
                  <input
                    type="text"
                    value={otpPhone}
                    onChange={(e) => setOtpPhone(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white font-mono text-sm focus:outline-none focus:border-emerald-500"
                    placeholder="10-digit phone"
                  />
                </div>
                {otpError && <p className="text-brand-red text-xs">{otpError}</p>}
                <button
                  onClick={sendOtp}
                  disabled={otpLoading}
                  className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2.5 rounded-lg text-sm transition-all disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                  {otpLoading ? "Sending OTP..." : "Send OTP"}
                </button>
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-gray-400 text-xs">OTP sent to <span className="text-white font-mono">{otpPhone}</span></p>
                <div>
                  <label className="block text-[11px] text-gray-400 font-mono mb-1">Enter 6-digit OTP</label>
                  <input
                    type="text"
                    maxLength={6}
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, ""))}
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-white font-mono text-lg text-center tracking-[0.5em] focus:outline-none focus:border-emerald-500"
                    placeholder="000000"
                  />
                </div>
                {otpError && <p className="text-brand-red text-xs">{otpError}</p>}
                <button
                  onClick={verifyOtp}
                  disabled={otpLoading || otpCode.length < 6}
                  className="w-full flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold py-2.5 rounded-lg text-sm transition-all disabled:opacity-50"
                >
                  <Smartphone className="h-4 w-4" />
                  {otpLoading ? "Verifying..." : "Verify OTP & Login"}
                </button>
                <button
                  onClick={() => { setOtpSent(false); setOtpError(""); setOtpCode(""); }}
                  className="text-xs text-gray-500 hover:text-gray-300 underline"
                >
                  Change phone or resend
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </header>
  );
}
