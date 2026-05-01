require('dotenv').config({ path: './.env' })
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(process.env.EXPO_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY)

async function run() {
  const { data, error } = await supabase
    .from('digest_sent')
    .select('*')
    .eq('channel', 'notion')
    .order('anchor_date', { ascending: false })
    .limit(5)
  console.log(data || error)
}
run()
