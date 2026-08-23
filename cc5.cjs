// READ-ONLY. Looks for any historical record of PRIOR claim-code values. Emits keys, never values.
const { Client } = require('pg');
(async()=>{
 const c=new Client({connectionString:process.env.MINTVAULT_DATABASE_URL,ssl:{rejectUnauthorized:false}});await c.connect();
 const o={};
 o.update_detail_keys = (await c.query(`
   SELECT k, COUNT(*)::int n FROM audit_log, LATERAL jsonb_object_keys(details) k
   WHERE entity_type='certificate' AND action='update' GROUP BY 1 ORDER BY n DESC LIMIT 25`)).rows;
 o.any_details_mentioning_code = (await c.query(`
   SELECT action, COUNT(*)::int n FROM audit_log
   WHERE details::text ILIKE '%claim_code%' OR details::text ILIKE '%claimCode%'
   GROUP BY 1 ORDER BY n DESC`)).rows;
 o.mv345_history = (await c.query(`
   SELECT action, created_at, jsonb_object_keys(details) k FROM audit_log
   WHERE entity_id IN ('MV3','MV4','MV5') ORDER BY created_at`)).rows;
 o.history_tables = (await c.query(`
   SELECT table_name FROM information_schema.tables WHERE table_schema='public'
   AND (table_name LIKE '%history%' OR table_name LIKE '%revision%' OR table_name LIKE '%version%'
        OR table_name LIKE '%snapshot%' OR table_name LIKE '%archive%') ORDER BY 1`)).rows;
 o.mv3_45_now = (await c.query(`
   SELECT certificate_number n, (claim_code_hash IS NOT NULL) has_code, claim_code_created_at made,
          ownership_status own, status, print_state ps, (grade IS NOT NULL) graded, issued_at
   FROM certificates WHERE certificate_number IN ('MV3','MV4','MV5') ORDER BY 1`)).rows;
 await c.end();console.log('###JSON###');console.log(JSON.stringify(o,null,1));
})().catch(e=>{console.log('FATAL',e.message);process.exit(1)});
