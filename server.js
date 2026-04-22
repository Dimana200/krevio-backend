import express from "express";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON
);

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;

app.use(cors({ origin: "*" }));
app.options("*", cors());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Krevio Backend OK", version: "3.0" });
});

// Генерира presigned URL за качване
app.post("/presign", async (req, res) => {
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Не си влязъл." });

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: "Невалиден токен." });

  const { fileName, mimeType, title, description, access } = req.body;
  if (!fileName || !mimeType || !title) {
    return res.status(400).json({ error: "Липсват данни." });
  }

  const ext = fileName.split(".").pop();
  const key = `videos/${user.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

  const command = new PutObjectCommand({
    Bucket:      BUCKET,
    Key:         key,
    ContentType: mimeType,
  });

  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
  const fileUrl   = `${process.env.R2_PUBLIC_URL}/${key}`;

  // Записва в Supabase
  await sb.from("videos").insert({
    user_id:      user.id,
    title:        title,
    description:  description || "",
    file_url:     fileUrl,
    access_level: access || "free",
  });

  res.json({ uploadUrl, fileUrl, key });
});

app.listen(PORT, () => {
  console.log(`Krevio Backend v3.0 on port ${PORT}`);
});
