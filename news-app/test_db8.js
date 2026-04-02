const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
if (!process.env.EXPO_PUBLIC_SUPABASE_URL) require('dotenv').config({ path: '.env' });
const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
async function run() {
  const { data, error } = await supabase.from('daily_news').select('published_date').limit(1);
  if (error) console.error("TEST1:", error.message);
  
  const res2 = await supabase.from('daily_news').select('published_at').limit(1);
  if (res2.error) console.error("TEST2:", res2.error.message);
}
run();
