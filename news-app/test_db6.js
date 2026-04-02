const { createClient } = require('@supabase/supabase-js');
require('dotenv').config({ path: '.env.local' });
if (!process.env.EXPO_PUBLIC_SUPABASE_URL) require('dotenv').config({ path: '.env' });
const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL, process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY);
async function run() {
  const { data, error } = await supabase.from('daily_news').select('*').limit(1);
  if (error) console.error("ERROR:", error);
  if (data && data.length) console.log("COLUMNS:", Object.keys(data[0]).join(', '));
}
run();
