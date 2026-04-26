import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import multer from "multer";

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;
const upload = multer({ dest: "/tmp/" });

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

async function generateThumbnail(videoPath, userId, videoKey) {
  const thumbPath = path.join("/tmp", `thumb_${Date.now()}.jpg`);
  try {
    await execAsync(`ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=480:-1" -q:v 2 "${thumbPath}" -y`);
    const thumbKey = `thumbnails/${userId}/${path.basename(videoKey, path.extname(videoKey))}.jpg`;
    const thumbBuffer = fs.readFileSync(thumbPath);
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: thumbKey, Body: thumbBuffer, ContentType: "image/jpeg",
    }));
    return `${process.env.R2_PUBLIC_URL}/${thumbKey}`;
  } catch(e) {
    console.error("Thumbnail failed:", e.message);
    return null;
  } finally {
    try { fs.unlinkSync(thumbPath); } catch(e) {}
  }
}

app.get("/", (req, res) => res.json({ status: "Krevio Backend OK", version: "8.0" }));

app.post("/upload", upload.single("video"), async (req, res) => {
  console.log("=== UPLOAD HIT ===");
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Не си влязъл." });

  try {
    const { data, error } = await sbAuth.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Невалиден токен." });

    const user = data.user;
    const { title, description, access } = req.body;
    if (!req.file || !title) return res.status(400).json({ error: "Липсват данни." });

    const ext = req.file.originalname.split(".").pop();
    const key = `videos/${user.id}/${Date.now()}.${ext}`;
    const fileBuffer = fs.readFileSync(req.file.path);

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key: key, Body: fileBuffer, ContentType: req.file.mimetype,
    }));

    const fileUrl = `${process.env.R2_PUBLIC_URL}/${key}`;

    const { error: dbError } = await sb.from("videos").insert({
      user_id: user.id, title, description: description || "",
      file_url: fileUrl, access_level: access || "free", thumbnail_url: null,
    });
    if (dbError) console.error("DB error:", dbError.message);
    else console.log("DB insert OK");

    res.json({ fileUrl });

    // Thumbnail асинхронно
    setTimeout(async () => {
      const thumbUrl = await generateThumbnail(req.file.path, user.id, key);
      if (thumbUrl) {
        await sb.from("videos").update({ thumbnail_url: thumbUrl }).eq("file_url", fileUrl);
        console.log("Thumbnail saved:", thumbUrl);
      }
      try { fs.unlinkSync(req.file.path); } catch(e) {}
    }, 1000);

  } catch(e) {
    console.error("Error:", e.message);
    res.status(500).json({ error: "Сървърна грешка." });
  }
});

app.listen(PORT, () => console.log(`Krevio Backend v8.0 on port ${PORT}`));
