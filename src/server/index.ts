// src/server/index.ts
import { ChatMessage } from "./shared";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const MODELS = {
  WORKERS_AI: { model: "@cf/llama-3" }, // Adjust as needed
};

interface Env {
  Chat: DurableObjectNamespace;
  memy: KVNamespace;
  AI: any;
  OPENROUTER_API_KEY?: string;
  ASSETS: Fetcher;
}

interface SessionData {
  sessionId: string;
  messages: ChatMessage[];
  created: number;
}

export class ingeniumVeritasChat implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async normalizeQuery(query: string): Promise<string> {
    if (!query || typeof query !== "string") return "";
    return query
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .substring(0, 100);
  }

  async callModel(modelKey: string, prompt: string): Promise<{ answer: string }> {
    if (modelKey === "WORKERS_AI") {
      if (!this.env.AI) throw new Error("AI binding not found.");
      const response = await this.env.AI.run(MODELS.WORKERS_AI.model, { prompt });
      return { answer: response.response };
    } else {
      if (!this.env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY secret not found.");
      const modelConfig = MODELS[modelKey] || { model: modelKey };
      const openRouterUrl = "https://openrouter.ai/api/v1/chat/completions";
      const response = await fetch(openRouterUrl, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://ingenium-veritas.com",
          "X-Title": "Ingenium Veritas",
        },
        body: JSON.stringify({
          model: modelConfig.model,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      if (!response.ok) throw new Error(`OpenRouter error: ${response.status} ${await response.text()}`);
      const data = await response.json();
      if (!data.choices?.[0]?.message) throw new Error("Invalid OpenRouter response structure");
      return { answer: data.choices[0].message.content };
    }
  }

  async addMessage(message: ChatMessage, sessionId: string) {
    const session: SessionData = (await this.state.storage.get(`session:${sessionId}`)) || {
      sessionId,
      messages: [],
      created: Date.now(),
    };
    session.messages.push(message);
    await this.state.storage.put(`session:${sessionId}`, session);
  }

  async getHistory(sessionId: string): Promise<SessionData> {
    return (await this.state.storage.get(`session:${sessionId}`)) || {
      sessionId,
      messages: [],
      created: Date.now(),
    };
  }

  async exportConversation(sessionId: string): Promise<Response> {
    const session = await this.getHistory(sessionId);
    return new Response(JSON.stringify(session, null, 2), {
      headers: {
        "Content-Type": "application/json",
        "Content-Disposition": `attachment; filename=session-${sessionId}.json`,
      },
    });
  }

  async importConversation(jsonData: string, sessionId: string): Promise<Response> {
    try {
      const importedSession = JSON.parse(jsonData) as SessionData;
      if (importedSession.sessionId !== sessionId) {
        return new Response(JSON.stringify({ error: "Invalid session ID" }), { status: 400, headers: CORS_HEADERS });
      }
      await this.state.storage.put(`session:${sessionId}`, importedSession);
      return new Response(JSON.stringify({ success: true, message: "Session imported" }), {
        status: 200,
        headers: CORS_HEADERS,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON format" }), { status: 400, headers: CORS_HEADERS });
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const sessionId = url.searchParams.get("sessionId") || crypto.randomUUID();

    // Conversation endpoints
    if (path === "/conversation/add" && request.method === "POST") {
      try {
        const { query, answer } = await request.json();
        const message: ChatMessage = { id: crypto.randomUUID(), content: query, user: "user", role: "user" };
        const responseMessage: ChatMessage = { id: crypto.randomUUID(), content: answer, user: "ai", role: "assistant" };
        await this.addMessage(message, sessionId);
        await this.addMessage(responseMessage, sessionId);
        return new Response(JSON.stringify({ success: true }), { headers: CORS_HEADERS });
      } catch (error) {
        return new Response(JSON.stringify({ error: (error as Error).message }), { status: 400, headers: CORS_HEADERS });
      }
    }

    if (path === "/conversation/history" && request.method === "GET") {
      try {
        const history = await this.getHistory(sessionId);
        return new Response(JSON.stringify(history), { headers: CORS_HEADERS });
      } catch (error) {
        return new Response(JSON.stringify({ error: (error as Error).message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    if (path === "/conversation/export" && request.method === "GET") {
      return await this.exportConversation(sessionId);
    }

    if (path === "/conversation/import" && request.method === "POST") {
      const jsonData = await request.text();
      return await this.importConversation(jsonData, sessionId);
    }

    // Admin API endpoints (truthengine)
    if (path === "/api/load" && request.method === "POST") {
      try {
        const body = await request.json();
        const query = body.query;
        if (!query) {
          return new Response(JSON.stringify({ error: "Query is required" }), { status: 400, headers: CORS_HEADERS });
        }
        const normalizedQuery = await this.normalizeQuery(query);
        const cacheKey = `truth:${normalizedQuery}`;
        const data = await this.env.memy.get(cacheKey);
        return new Response(JSON.stringify({ answer: data ? JSON.parse(data).answer : null }), {
          status: 200,
          headers: CORS_HEADERS,
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    if (path === "/api/save" && request.method === "POST") {
      try {
        const body = await request.json();
        const { query, answer, editor } = body;
        if (!query || !answer) {
          return new Response(JSON.stringify({ error: "query and answer are required" }), {
            status: 400,
            headers: CORS_HEADERS,
          });
        }
        const normalizedQuery = await this.normalizeQuery(query);
        const cacheKey = `truth:${normalizedQuery}`;
        const cacheData = {
          answer,
          lastEditedBy: editor || "user",
          edited: true,
          timestamp: Date.now(),
          created: Date.now(),
        };
        const existingData = await this.env.memy.get(cacheKey);
        if (existingData) {
          cacheData.created = JSON.parse(existingData).created;
        }
        await this.env.memy.put(cacheKey, JSON.stringify(cacheData));
        const session = await this.getHistory(sessionId);
        const message: ChatMessage = { id: crypto.randomUUID(), content: query, user: editor || "user", role: "user" };
        const responseMessage: ChatMessage = { id: crypto.randomUUID(), content: answer, user: "ai", role: "assistant" };
        await this.addMessage(message, sessionId);
        await this.addMessage(responseMessage, sessionId);
        const queryCount = await this.env.memy.get(`count:${normalizedQuery}`);
        const newCount = queryCount ? parseInt(queryCount) + 1 : 1;
        await this.env.memy.put(`count:${normalizedQuery}`, newCount.toString());
        if (newCount > 5) {
          await this.env.memy.put(`cache:${normalizedQuery}`, JSON.stringify({ answer, timestamp: Date.now() }));
        }
        return new Response(JSON.stringify({ success: true, message: `Saved ${cacheKey}` }), {
          status: 200,
          headers: CORS_HEADERS,
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    // Query with AI
    if (path === "/query" && request.method === "POST") {
      try {
        const { query, isFollowUp } = await request.json();
        if (!query) {
          return new Response(JSON.stringify({ error: "Query is required" }), { status: 400, headers: CORS_HEADERS });
        }
        const normalizedQuery = await this.normalizeQuery(query);
        const cacheKey = `truth:${normalizedQuery}`;
        const cached = await this.env.memy.get(`cache:${normalizedQuery}`);
        if (cached) {
          const session = await this.getHistory(sessionId);
          const message: ChatMessage = { id: crypto.randomUUID(), content: query, user: "user", role: "user" };
          const responseMessage: ChatMessage = {
            id: crypto.randomUUID(),
            content: JSON.parse(cached).answer,
            user: "ai",
            role: "assistant",
          };
          await this.addMessage(message, sessionId);
          await this.addMessage(responseMessage, sessionId);
          return new Response(JSON.stringify({ answer: JSON.parse(cached).answer, sessionId }), {
            headers: CORS_HEADERS,
          });
        }
        const session = await this.getHistory(sessionId);
        const recentMessages = session.messages.slice(-2).filter((m) => m.role === "assistant");
        const prompt = isFollowUp
          ? `Context: ${JSON.stringify(recentMessages.map((m) => ({ role: m.role, content: m.content })))}\nQuery: ${query}`
          : query;
        const aiResponse = await this.callModel("WORKERS_AI", prompt);
        const cacheData = {
          answer: aiResponse.answer,
          lastEditedBy: "ai",
          edited: false,
          timestamp: Date.now(),
          created: Date.now(),
        };
        await this.env.memy.put(cacheKey, JSON.stringify(cacheData));
        const message: ChatMessage = { id: crypto.randomUUID(), content: query, user: "user", role: "user" };
        const responseMessage: ChatMessage = {
          id: crypto.randomUUID(),
          content: aiResponse.answer,
          user: "ai",
          role: "assistant",
        };
        await this.addMessage(message, sessionId);
        await this.addMessage(responseMessage, sessionId);
        const queryCount = await this.env.memy.get(`count:${normalizedQuery}`);
        const newCount = queryCount ? parseInt(queryCount) + 1 : 1;
        await this.env.memy.put(`count:${normalizedQuery}`, newCount.toString());
        if (newCount > 5) {
          await this.env.memy.put(`cache:${normalizedQuery}`, JSON.stringify({ answer: aiResponse.answer, timestamp: Date.now() }));
        }
        return new Response(JSON.stringify({ answer: aiResponse.answer, sessionId }), { headers: CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    // Top queries per day
    if (path === "/top-queries" && request.method === "GET") {
      try {
        const today = new Date().toISOString().split("T")[0];
        const keys = await this.env.memy.list({ prefix: `count:` });
        const topQueries = [];
        for (const key of keys.keys) {
          const count = parseInt(await this.env.memy.get(key.name) || "0");
          const query = key.name.replace("count:", "");
          const queryData = await this.env.memy.get(`truth:${query}`);
          if (queryData) {
            const { timestamp } = JSON.parse(queryData);
            const queryDate = new Date(timestamp).toISOString().split("T")[0];
            if (queryDate === today) {
              topQueries.push({ query, count });
            }
          }
        }
        topQueries.sort((a, b) => b.count - a.count);
        return new Response(JSON.stringify(topQueries.slice(0, 10)), { headers: CORS_HEADERS });
      } catch (e) {
        return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: CORS_HEADERS });
      }
    }

    return new Response(JSON.stringify({ error: "Invalid endpoint" }), { status: 404, headers: CORS_HEADERS });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const sessionId = url.searchParams.get("sessionId") || crypto.randomUUID();
    const chatId = env.Chat.idFromName(`ingenium-veritas:${sessionId}`);
    const chatInstance = env.Chat.get(chatId);
    return chatInstance.fetch(request);
  },
};