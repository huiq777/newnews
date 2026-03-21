# Frontend

React Native (Expo) targeting web first. The entire UI is built with standard components — no native modules are required, so the web build works without friction.

---

## Project Setup

```bash
npx create-expo-app@latest app --template tabs
cd app
npx expo install @supabase/supabase-js expo-router react-native-markdown-display
```

Configure `app.json` for web:
```json
{
  "expo": {
    "web": {
      "bundler": "metro",
      "output": "static"
    }
  }
}
```

Initialize the Supabase client (e.g., `lib/supabase.ts`):
```typescript
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  process.env.EXPO_PUBLIC_SUPABASE_URL!,
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!
)
```

---

## Screen Inventory

### `/(auth)/login`
**Purpose:** Email/password sign-in. Redirects to feed on success.

Key behaviors:
- Call `supabase.auth.signInWithPassword({ email, password })`
- On success, Expo Router redirects to `/(app)/feed`
- Show an inline error message on failure (do not clear the form)
- Include a "Sign up" link that calls `supabase.auth.signUp()`

### `/(app)/feed`
**Purpose:** The daily news feed. The primary read surface.

Key behaviors:
- Fetch on mount: `supabase.from('daily_news').select('id, title, summary, published_at, sources(name)').order('published_at', { ascending: false })`
- Render each article as a card: source name, title, and the 3 bullet-point summary
- Summary is AI-generated plain text — render as-is, no markdown parser needed here
- Pull-to-refresh support
- Tapping an article card could open the original URL in the browser (optional for v1)

### `/(app)/chat`
**Purpose:** AI chat interface with two chatbots in a tabbed layout.

- **Tab 1 — "Live News"** calls `chat-live`
- **Tab 2 — "Deep Dive"** calls `chat-rag`

Each tab is an independent chat UI with its own message history and session state.

---

## Chat UI — Functional Requirements

These are non-negotiable functional behaviors. Visual design is separate.

### Streaming

Do not use `supabase.functions.invoke()` — it buffers the full response before returning, which makes the UI feel frozen during multi-second AI responses.

Use `fetch` with `ReadableStream` directly. See the full implementation pattern in [edge-functions.md](edge-functions.md).

### Markdown Rendering

Both chatbots can return markdown-formatted text. Use `react-native-markdown-display` to render assistant messages.

```tsx
import Markdown from 'react-native-markdown-display'

<Markdown>{message.content}</Markdown>
```

### `<think>` Block Rendering (Chatbot 2 only)

DeepSeek-R1 emits its reasoning process as `{ "type": "thinking", "content": "..." }` events before the final answer. This must be surfaced to the user as a collapsible accordion to highlight the "intellectual" nature of the bot.

```tsx
// Pseudocode — adapt to your component library

function ThinkingAccordion({ content }: { content: string }) {
  const [open, setOpen] = useState(false)
  return (
    <Pressable onPress={() => setOpen(!open)}>
      <Text>View reasoning {open ? '▲' : '▼'}</Text>
      {open && <Text style={styles.thinking}>{content}</Text>}
    </Pressable>
  )
}
```

Accumulate all `"thinking"` chunks into a single string and render one `ThinkingAccordion` per assistant turn. Accumulate `"content"` chunks separately and render as markdown.

### Session Lifecycle (Chatbot 2 only)

`chat-rag` requires a `session_id`. The lifecycle is:

1. User opens the Deep Dive tab → no session yet
2. User sends their first message → create the session:
   ```typescript
   const { data } = await supabase
     .from('chat_sessions')
     .insert({ title: firstMessage.slice(0, 50) })
     .select('id')
     .single()
   const sessionId = data.id
   ```
3. Pass `sessionId` to every subsequent `chat-rag` call in this tab
4. On tab unmount or "New Chat" button press → reset `sessionId` to null

The Edge Function saves messages to the database — the frontend does not need to write messages directly.

---

## Deployment

Build the static web output:
```bash
npx expo export --platform web
```

This outputs to the `dist/` folder.

Deploy to Vercel:
1. Push the project to GitHub
2. Import the repo in Vercel
3. Set the build command to `npx expo export --platform web`
4. Set the output directory to `dist`
5. Add environment variables in Vercel project settings:
   - `EXPO_PUBLIC_SUPABASE_URL`
   - `EXPO_PUBLIC_SUPABASE_ANON_KEY`

For local development: `npx expo start --web`
