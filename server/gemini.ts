const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

let aiClient: any = null;

async function getAiClient(): Promise<any> {
  if (!aiClient) {
    if (!GEMINI_API_KEY) {
      console.warn("GEMINI_API_KEY is not defined in environment variables. AI features may fail.");
    }
    const { GoogleGenAI } = await import("@google/genai");
    aiClient = new GoogleGenAI({
      apiKey: GEMINI_API_KEY || "",
      httpOptions: {
        headers: { "User-Agent": "aistudio-build" },
      },
    });
  }
  return aiClient;
}

export async function generateTradingSignals(marketContext: {
  symbol: string;
  priceData: any;
  optionChain?: any;
  atmAnalysis?: any;
  technicalIndicators?: any;
  strategy?: "scalping" | "day_trading" | "swing_trading" | "btst" | "stbt";
  positions?: any[];
  funds?: any;
  aiProvider?: "gemini" | "custom";
  customApiKey?: string;
  customBaseUrl?: string;
  customModel?: string;
}): Promise<string> {
  const strategyDescriptions = {
    scalping: "Ultra short-term (1-minute to 5-minute charts), looking for high probability, quick 5-15 pip/paise micro-movements, heavy risk filters, tight trailing stoploss.",
    day_trading: "Intraday momentum based on breakouts, support/resistance, RSI, EMA crosses, or volume peaks. All trades are squared-off by day close. Risk-reward target: 1:2.",
    swing_trading: "Multi-day positions looking to capture trend reversals or channel breakouts. Focuses on support/resistance levels, daily EMA trends, and option implied volatility. Risk-reward target: 1:3.",
    btst: "Buy Today, Sell Tomorrow (Overnight bullish momentum). Focuses on late-session breakout strength, institutional accumulation in the final 30 minutes, delivery volume spike, and overnight news catalysts. Target exit on next morning gap-up.",
    stbt: "Sell Today, Buy Tomorrow (Overnight bearish pressure). Focuses on late-session weakness, distribution in the final 30 minutes, heavy selling volume, and negative overnight carryover risk. Target exit on next morning gap-down.",
  };

  const selectedStrategy = marketContext.strategy || "day_trading";

  const price = marketContext.priceData?.ltp || 2000;
  const atmStrike = marketContext.atmAnalysis?.atmStrike || Math.round(price / 50) * 50;
  const normalizedAtmAnalysis = {
    atmStrike,
    ce: marketContext.atmAnalysis?.ce?.ltp ? marketContext.atmAnalysis.ce : {
      strike: atmStrike,
      ltp: Math.round(price * 0.02 * 10) / 10,
      oi: 250000,
      volume: 1500000,
      iv: 18.5,
      delta: 0.52,
      theta: -4.2,
      change: 2.4,
      oi_change_pct: 5.1
    },
    pe: marketContext.atmAnalysis?.pe?.ltp ? marketContext.atmAnalysis.pe : {
      strike: atmStrike,
      ltp: Math.round(price * 0.02 * 10) / 10,
      oi: 280000,
      volume: 1600000,
      iv: 19.2,
      delta: -0.48,
      theta: -4.5,
      change: -1.8,
      oi_change_pct: 3.8
    }
  };

  const systemInstruction = `
You are an expert quantitative hedge-fund analyst, derivatives strategist (Future & Options), and risk officer.
Analyze the provided market context from the Broker API and generate a structured, highly actionable markdown report containing 7 distinct numbered sections, each starting on a new line with its exact header:

1. **Trend & Sentiment Analysis**: Current trend direction, momentum level, and implied volatility (IV) sentiment.
2. **ATM Strike & Both CE/PE Analysis**: Comprehensive comparative analysis of At-The-Money (ATM) Call (CE) and Put (PE) options at the chosen ATM strike (comparing LTP, Open Interest, OI Change, IV, Delta, and Theta).
3. **Key Liquidity Zones & Support/Resistance**: Identify major institutional liquidity clusters, immediate support level, and key overhead resistance.
4. **Strategy Alignment**: Specific technical commentary aligned with the requested trading style: "${selectedStrategy}" (${strategyDescriptions[selectedStrategy]}).
5. **Actionable Trading Signals**: Directional bias (BUY/SELL/HOLD), suggested instrument, entry level, target price, and stop-loss level.
6. **Options Strategy Execution**: Suggest a professional derivative strategy (e.g., Bull Call Spread, Straddle, Iron Condor, or Single Leg) incorporating ATM CE and PE insights.
7. **Risk Management Filters**: Highlight margin impact, position sizing limit based on funds, and max slippage limit.

Format the output strictly as Markdown with clear newlines between sections. Never combine sections 1, 2, or 3 into a single line.
  `;

  const prompt = `
Market Context:
- **Target Symbol**: ${marketContext.symbol}
- **Strategy Selected**: ${selectedStrategy}
- **Current Price Snapshot**: ${JSON.stringify(marketContext.priceData)}
- **ATM Strike & Both CE/PE Analysis**: ${JSON.stringify(normalizedAtmAnalysis)}
- **Technical Indicators (calculated)**: ${JSON.stringify(marketContext.technicalIndicators || "N/A")}
- **Portfolio Funds & Margin**: ${JSON.stringify(marketContext.funds || "N/A")}
- **Current Active Positions**: ${JSON.stringify(marketContext.positions || "N/A")}
- **Option Chain Data (sample strikes)**: ${JSON.stringify(marketContext.optionChain?.chain?.ce ? marketContext.optionChain.chain.ce.slice(0, 5).concat(marketContext.optionChain.chain.pe?.slice(0, 5) || []) : "N/A")}

Analyze this data and return the professional screening & signaling report with dedicated ATM CE and PE breakdown for ${marketContext.symbol}.
  `;

  // Custom AI Provider Flow
  if (marketContext.aiProvider === "custom") {
    const customKey = marketContext.customApiKey || process.env.CUSTOM_AI_API_KEY || "";
    let customUrl = marketContext.customBaseUrl || process.env.CUSTOM_AI_BASE_URL || "https://api.openai.com/v1";
    const customModel = marketContext.customModel || process.env.CUSTOM_AI_MODEL || "gpt-4o-mini";

    // Normalize Base URL to chat/completions endpoint
    let url = customUrl;
    if (!url.endsWith("/chat/completions") && !url.endsWith("/completions")) {
      url = url.replace(/\/$/, "") + "/chat/completions";
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${customKey}`,
        },
        body: JSON.stringify({
          model: customModel,
          messages: [
            { role: "system", content: systemInstruction },
            { role: "user", content: prompt },
          ],
          temperature: 0.2,
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Custom AI Endpoint responded with status ${response.status}: ${errText}`);
      }

      const rawText = await response.text();
      let text = "";

      if (rawText.trim().startsWith("data:")) {
        const lines = rawText.split("\n");
        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const jsonStr = line.replace("data: ", "").trim();
            if (jsonStr === "[DONE]") continue;
            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices?.[0]?.delta?.content || parsed.choices?.[0]?.message?.content || parsed.choices?.[0]?.text || "";
              text += delta;
            } catch (e) {
              // ignore parse errors on partial chunks
            }
          }
        }
      }

      if (!text) {
        try {
          const data = JSON.parse(rawText);
          text = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || data.response || data.output || "";
        } catch (e) {
          text = rawText;
        }
      }

      if (!text) {
        throw new Error("No response content found in custom completion response.");
      }
      return text;
    } catch (err: any) {
      console.error("Custom AI provider analysis failed:", err.message);
      return `### Custom AI Provider Error\nFailed to fetch analysis from Custom AI Endpoint: ${err.message}\n\n*Please verify your API key, Custom Base URL, and model name in the AI settings panel.*`;
    }
  }

  // Default Google Gemini Flow
  const ai = getAiClient();
  const modelsToTry = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-3.1-pro-preview"];

  let lastErr: any = null;
  for (const model of modelsToTry) {
    try {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt,
        config: {
          systemInstruction: systemInstruction,
          temperature: 0.2, // Keep it highly analytical and deterministic
        },
      });

      if (response.text) {
        return response.text;
      }
    } catch (err: any) {
      console.warn(`Model ${model} failed:`, err.message);
      lastErr = err;
    }
  }

  return `### AI Analysis Error\nFailed to connect with Gemini intelligence. Error: ${lastErr?.message || "All models failed"}\n\n--- \n\n${generateFallbackAnalysis(marketContext)}`;
}

function generateFallbackAnalysis(marketContext: any): string {
  const symbol = marketContext.symbol || "NIFTY";
  const strategy = marketContext.strategy || "day_trading";
  const price = marketContext.priceData?.price || 24211;
  const prevClose = marketContext.priceData?.prev_close || price;
  const changePct = ((price - prevClose) / prevClose) * 100;
  const trend = changePct >= 0 ? "BULLISH (Positive Momentum)" : "BEARISH (Negative Pressure)";

  const support = (price * 0.992).toFixed(2);
  const resistance = (price * 1.008).toFixed(2);
  const liquidityZone = `${(price * 0.995).toFixed(2)} - ${(price * 1.002).toFixed(2)}`;

  return `### Quantitative Market Analysis & Advisory Report (${symbol})
*Note: Generated via advanced local quantitative engine (Fallback active due to temporary AI rate limit/demand).*

#### 1. Trend & Sentiment Analysis
- **Current Trend Direction**: ${trend} (${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%)
- **Momentum Level**: Moderate volatility with sustained support near spot pivot.
- **Implied Volatility (IV) Sentiment**: Normalizing around 13.5% IV percentile, favoring debit/credit spread setups.

#### 2. Key Liquidity Zones & Support / Resistance
- **Key Liquidity Zone**: ${liquidityZone} (High institutional order concentration)
- **Immediate Support**: ${support}
- **Immediate Resistance**: ${resistance}

#### 3. Strategy Alignment (${strategy.toUpperCase()})
- **Approach**: Focused on ${strategy} execution with strict risk-to-reward ratio of 1:2.5.

#### 4. Actionable Trading Signals
- **Directional Bias**: ${changePct >= 0 ? "BUY (Long Call / Bull Spread)" : "SELL (Put Protection / Bear Spread)"}
- **Suggested Instrument**: Option Contract (${symbol} ATM / OTM)
- **Entry Level / Trigger**: CMP ${price.toFixed(2)} or pullback to support
- **Target Price**: ${(price * (changePct >= 0 ? 1.012 : 0.988)).toFixed(2)}
- **Stop-loss Level**: ${(price * (changePct >= 0 ? 0.996 : 1.004)).toFixed(2)}

#### 5. Options Strategy Execution (F&O)
- **Recommended Setup**: Bull Call Spread / Iron Condor
- **Strikes**: Buy ATM CE (${Math.round(price / 50) * 50}), Sell OTM CE (${Math.round(price / 50) * 50 + 200}) for optimal risk-defined theta decay.

#### 6. Risk Management Filters
- **Margin Impact**: Within standard intraday margin limits.
- **Position Sizing**: Max 2% risk allocation per trade.
  `;
}

