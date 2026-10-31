# رسائل الحساب بالعربي وإعدادات Supabase Auth

رسائل التأكيد وإعادة تعيين كلمة المرور تُرسلها Supabase، وقوالبها الافتراضية إنجليزية. هنا القالبان العربيان الوحيدان اللذان يستعملهما الموقع، وكل إعدادات لوحة Supabase التي يحتاجها الدخول في مكان واحد. لا شيء من هذا يُضبط من الشيفرة: يُلصق من لوحة Supabase.

## القوالب (Authentication ← Emails ← Templates)

| القالب في Supabase | عنوان الرسالة (Subject) | الملف |
|---|---|---|
| Confirm sign up | `تأكيد حسابك في Élan Scents` | `confirm-signup.html` |
| Reset password | `إعادة تعيين كلمة المرور` | `reset-password.html` |

- يُلصق محتوى الملف كاملًا في خانة الرسالة (Message body)، والعنوان في خانة Subject، ثم Save.
- قالب «Reset password» واحد لكل من يطلب نسيان كلمة المرور: العملاء من صفحة الحساب، ومالك الموقع من صفحة دخول المحرر. لذلك نصّه عام.
- القوالب الأخرى (Magic link وChange email وInvite وReauthentication) لا يستعملها الموقع الآن، فتُترك كما هي.
- المتغيّر الوحيد المستعمل `{{ .ConfirmationURL }}`: لا بريد العميل ولا اسمه في نص الرسالة، ولا صور، ولا روابط أخرى، ولا عبارات ترويجية (توصية توثيق Supabase لرسائل الحساب حتى لا تُصنَّف دعاية).

## الإعدادات الأخرى في Supabase Auth

| المكان | القيمة |
|---|---|
| Authentication ← URL Configuration ← **Site URL** | `https://elan-scents.hossamthapitelgharib.workers.dev` |
| Redirect URLs (إضافة) | `https://elan-scents.hossamthapitelgharib.workers.dev/account.html` (نسيان كلمة المرور للعملاء) |
| Redirect URLs (إضافة) | `https://elan-scents.hossamthapitelgharib.workers.dev/editor-reset` (نسيان كلمة السر لمالك المحرر؛ بدونها يفتح الرابط الصفحة الرئيسية بدل صفحة التعيين) |
| Authentication ← SMTP | خدمة بريد خاصة (Custom SMTP): بريد Supabase المدمج يرسل لأعضاء فريق المشروع فقط، فلا تصل رسائل التأكيد لأي عميل جديد قبل ضبطها. |

عند شراء نطاق خاص بالموقع تُكرَّر القيم الثلاث الأولى بالنطاق الجديد.

## تجربة بعد اللصق

1. Authentication ← Emails ← Templates: أرسل رسالة تجريبية لنفسك (زر Send test email إن ظهر) أو اطلب «نسيت كلمة المرور» من صفحة الحساب ببريد حسابك.
2. افتح الرسالة من الموبايل والكمبيوتر: النص من اليمين لليسار، والزر ذهبي، والرابط يفتح الصفحة الصحيحة.
