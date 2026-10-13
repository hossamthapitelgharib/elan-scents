# elan-editor-server (Railway)

سيرفر صغير بدون مكتبات بيشغّل `api/editor.js`. موقع فيرسال بيحوّل `/api/editor` ليه، فالمتصفح يفضل على نفس الدومين.

## متغيرات Railway
- `GITHUB_TOKEN` (المالكة تضيفه بنفسها، Contents: Read and write، مستودع elan-scents فقط)
- `SUPABASE_URL` و `SUPABASE_SERVICE_ROLE_KEY`
- `EDITOR_TARGET_BRANCH` = `editor-staging` للمعاينة (و`main` بعد موافقتك فقط)
- `EDITOR_SITE_ORIGIN` = رابط الموقع (https://...)
- `EDITOR_ENV` = `production` (مطلوب لو الفرع `main`)

## تشغيل
`npm start` — فحص الصحة: `/health`
