# دليل نشر ECHO يدوياً

الملف ده فيه كل حاجة محتاجها عشان تنشر المشروع بنفسك.

---

## طريقة 1: نشر على Vercel مباشرة (الأسهل — 5 دقايق)

1. افتح https://vercel.com وسجّل دخول
2. اضغط **Add New → Project**
3. لو عندك المشروع على GitHub: اختار المستودع وعملّ Import
   - أو اسحب وارمي المجلد: اضغط **Deploy** واختار مجلد `echo` بعد فك الضغط (لازم تكون فاك الضغط الأول)
4. سيب خانة Environment Variables فاضية — كل حاجة اختيارية والتطبيق شغال بدونها
5. اضغط **Deploy** واستنى دقيقتين
6. خلاص! الموقع هيبقى جاهز على رابط زي: `https://echo-xxxx.vercel.app`

> ملحوظة: قبل ما ترفع المجلد، امسح منه مجلدات `node_modules` و`.next` لو موجودة (مش موجودين في الملف المضغوط أصلاً).

---

## طريقة 2: رفع على GitHub الأول وبعدين Vercel (لو عايز Git)

1. افتح https://github.com/new واعمل مستودع جديد اسمه `echo` (خليه Public لو هتربطه بـ Vercel المجاني)
2. فك ضغط الملف وادخل جوه مجلد `echo` في الترمينال:
   ```bash
   cd echo
   git init
   git add .
   git commit -m "ECHO with all overhaul updates"
   git branch -M main
   git remote add origin https://github.com/USERNAME/echo.git
   git push -u origin main
   ```
3. على Vercel: **Add New → Project → Import** المستودع بتاعك → **Deploy**

---

## إلغاء الرفع المجدول (لو موجود عندك على Vercel)

1. ادخل على https://vercel.com وافتح المشروع القديم (echo-wheat-one)
2. من فوق: تبويب **Crons** (أو Settings → Cron Jobs) — لو فيه أي مهمة مجدولة (زي weekly digest) امسحها
3. تبويب **Deployments** — لو فيه Deploy Hooks احذفها برضه عشان مفيش رفع تلقائي
4. لو عايز توقف المشروع القديم خالص: **Settings → General → Pause** أو احذفه من الـ menu

---

## متغيرات البيئة (كلها اختيارية!)

التطبيق شغال 100% من غير أي إعدادات. لو حبيت تطوّر الأداء بعدين:

| المتغير | الفايدة | ازاي تجيبه |
|---|---|---|
| `NEXT_PUBLIC_RAWG_API_KEY` | يشغّل كتالوج الألعاب (RAWG) — من غيره قسم الألعاب مقفول بأمان | https://rawg.io/apidocs (مجاني) |
| `NEXT_PUBLIC_SUPABASE_URL` | يشغّل المزامنة السحابية الاختيارية (حسابات اسم مستخدم + كلمة مرور) | من لوحة تحكم Supabase |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | المفتاح العام للمزامنة (RLS هو الحامي الفعلي) | من لوحة تحكم Supabase |
| `UPSTASH_REDIS_REST_URL` | تخزين مؤقت للطلبات (مش ضروري) | https://upstash.com (مجاني) |
| `UPSTASH_REDIS_REST_TOKEN` | مع التوكن بتاع Upstash | اختياري |

**ملاحظات مهمة (نسخة 1.3.0):**

- **مفيش أي ذكاء اصطناعي في التطبيق**: ميزات Ask ECHO وTaste Companion
  وweekly digest اتشالت بقرار المالك، ومفيش مفتاح AI خالص. الوضع موثّق في
  `docs/AI_POSTURE.md`.
- **الحسابات اسم مستخدم + كلمة مرور بس** — من غير بريد إلكتروني ولا Google
  ولا GitHub ولا استعادة كلمة مرور: لو نسيت كلمة المرور الحساب السحابي
  بيقفل نهائياً (بياناتك المحلية والتصدير مش بتتأثر). استخدم التطبيق من
  غير حساب عادي زي ما هو.
- Cloudflare هو وجهة الاستضافة المعتمدة (مش Vercel).

---

## التعديلات الجديدة اللي في النسخة دي (25 ملف)

- بحث واعي بالتصنيفات في كل المصادر السبعة
- توسيع مكتبة المحتوى (demoCatalogue)
- شاشة Discover بتدعم كل الأنواع السبعة
- تحديثات على كل الـ providers: AniList, Kitsu, TVMaze, IMDb, RAWG, Open Library
- تحسينات على Onboarding وMap Screen والـ i18n والـ export/import
- سكريبت اختبار جديد: `scripts/test-overhaul.ts`

## التشغيل محلياً (اختياري)

```bash
cd echo
npm install
npm run dev
# افتح http://localhost:3000
```

لازم Node.js إصدار 20.9 أو أحدث.
