# Edge Functions

Two Supabase Edge Functions serve as the secure bridge between the frontend and the AI providers. They hold API keys server-side and stream responses back to the client.

Both functions require the user to be authenticated. The Supabase JS client automatically attaches the user's JWT to requests — the function verifies it before doing anything else.

**MVP provider:** Both functions use Groq's free API tier. Upgrade paths are noted in each section.

---

## `chat-live` — Chatbot 1 (General AI Assistant)

### Purpose
Takes a user's question, forwards it to Groq Llama 3.3 70B, and streams the response back. No database reads or writes.

> **Upgrade path:** swap to Perplexity Sonar ($5/mo) for live web search, or add a Tavily search call (free, 1K/mo) before the Groq call. One URL + one model name change in the function.

### Request

```
POST /functions/v1/chat-live
Authorization: Bearer <supabase_user_jwt>
Content-Type: application/json

{
  "prompt": string   // The user's question
}
```

### Response

```
Content-Type: text/event-stream

data: {"choices": [{"delta": {"content": "Here is"}}]}
data: {"choices": [{"delta": {"content": " what I found"}}]}
data: [DONE]
```

Standard Groq/OpenAI SSE format. Parse with `event.choices[0].delta.content`.

### Internal Flow

```
1. Verify JWT (reject if not authenticated)
2. Forward prompt to Groq:
   POST https://api.groq.com/openai/v1/chat/completions
   {
     "model": "llama-3.3-70b-versatile",
     "stream": true,
     "messages": [{ "role": "user", "content": prompt }]
   }
3. Pipe Groq's SSE stream directly to the client response
```

### Required Edge Function Secret
- `GROQ_API_KEY`

---

## `chat-rag` — Chatbot 2 (Contextual RAG)

### Purpose
Takes a user's question, finds the most relevant articles from the stored news feed using vector similarity search, injects them as context into a Groq DeepSeek-R1 distill prompt, and streams the response. Saves the conversation to the database.

> **Upgrade path:** swap to DeepSeek API directly (`deepseek-reasoner`) for the full model. Same API format, same `reasoning_content` field.

### Request

```
POST /functions/v1/chat-rag
Authorization: Bearer <supabase_user_jwt>
Content-Type: application/json

{
  "question": string,    // The user's question
  "session_id": string   // UUID of the chat_sessions row (create one first if new conversation)
}
```

### Response

```
Content-Type: text/event-stream

data: {"type": "thinking", "content": "Let me consider the context..."}
data: {"type": "thinking", "content": " The article mentions that..."}
data: {"type": "content",  "content": "Based on recent news,"}
data: {"type": "content",  "content": " the situation is..."}
data: [DONE]
```

Two event types:
- `"thinking"` — content from the model's `reasoning_content` field. Display in a collapsible accordion labeled "View reasoning".
- `"content"` — the final answer text. Display in the main chat bubble.

### Internal Flow

```
1. Verify JWT (reject if not authenticated)
2. Verify session_id belongs to the authenticated user
   (SELECT 1 FROM chat_sessions WHERE id = session_id AND user_id = auth.uid())

3. Embed the question using Cohere:
   POST https://api.cohere.com/v1/embed
   {
     "model": "embed-english-v3.0",
     "input_type": "search_query",   ← MUST be "search_query" here (not "search_document")
     "texts": [question]
   }

4. Similarity search in pgvector:
   SELECT id, title, summary, 1 - (embedding <=> $query_vector) AS score
   FROM daily_news
   ORDER BY score DESC
   LIMIT 5

5. Build the prompt:
   System: "You are a thoughtful news analyst. Answer the user's question based only
            on the provided articles. If the articles don't contain relevant information,
            say so clearly."
   User:   "Articles:\n\n{formatted top-5 summaries}\n\nQuestion: {question}"

6. Call Groq deepseek-r1-distill-llama-70b with streaming:
   POST https://api.groq.com/openai/v1/chat/completions
   { "model": "deepseek-r1-distill-llama-70b", "stream": true, "messages": [...] }

7. Parse the stream:
   - delta.reasoning_content chunks → emit { "type": "thinking", "content": chunk }
   - delta.content chunks           → emit { "type": "content",  "content": chunk }

8. After stream completes, save to database:
   INSERT INTO messages (session_id, role, content) VALUES
     (session_id, 'user', question),
     (session_id, 'assistant', full_response_text)
```

### Required Edge Function Secrets
- `GROQ_API_KEY`
- `COHERE_API_KEY`

---

## Frontend Integration Notes

**Use `fetch` with `ReadableStream`, not `supabase.functions.invoke()`.**

`supabase.functions.invoke()` buffers the entire response before returning it. This defeats streaming and makes the UI feel unresponsive for multi-second AI responses. Use native `fetch`:

```typescript
const response = await fetch(
  `${supabaseUrl}/functions/v1/chat-rag`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ question, session_id }),
  }
);

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  const lines = decoder.decode(value).split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ') && line !== 'data: [DONE]') {
      const event = JSON.parse(line.slice(6));
      // handle event.type === 'thinking' or 'content'
    }
  }
}
```

**Session lifecycle:** Create the `chat_sessions` row on the user's first message, before calling `chat-rag`. Pass the returned `session_id` for all subsequent messages in that conversation.
