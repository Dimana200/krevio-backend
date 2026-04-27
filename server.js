import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "@supabase/supabase-js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const sbAuth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON);

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;

app.get("/", (req, res) => res.json({ status: "Krevio Backend OK", version: "9.0" }));

app.post("/presign", async (req, res) => {
  console.log("=== PRESIGN HIT ===");
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Не си влязъл." });
  try {
    const { data, error } = await sbAuth.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Невалиден токен." });
    const user = data.user;
    const { fileName, mimeType, title, description, access } = req.body;
    if (!fileName || !mimeType || !title) return res.status(400).json({ error: "Липсват данни." });
    const ext = fileName.split(".").pop();
    const key = `videos/${user.id}/${Date.now()}.${ext}`;
    // БЕЗ ContentType в командата — избягва CORS preflight на мобилен
    const command = new PutObjectCommand({ Bucket: BUCKET, Key: key });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const fileUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
    const { error: dbError } = await sb.from("videos").insert({
      user_id: user.id,
      title,
      description: description || "",
      file_url: fileUrl,
      access_level: access || "free",
      thumbnail_url: null,
    });
    if (dbError) console.error("DB error:", dbError.message);
    else console.log("DB insert OK");
    res.json({ uploadUrl, fileUrl, key });
  } catch(e) {
    console.error("Error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Krevio Backend v9.0 on port ${PORT}`));
