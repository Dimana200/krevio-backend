import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import cors from "cors";
import busboy from "busboy";
import { createClient } from "@supabase/supabase-js";

const app  = express();
const PORT = process.env.PORT || 3000;

// Supabase
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON
);

// R2 Client
const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET         = process.env.R2_BUCKET;
const MAX_SIZE       = parseInt(process.env.MAX_FILE_SIZE || "4294967296");
const ALLOWED_TYPES  = (process.env.ALLOWED_TYPES || "video/mp4,video/quicktime,video/avi,video/webm").split(",");

// CORS
app.use(cors({ origin: "*" }));
app.options("*", cors());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "Krevio Backend OK", version: "2.0" });
});

// UPLOAD endpoint
app.post("/upload", async (req, res) => {

  // 1. Check auth token
  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({ error: "Не си влязъл в акаунта." });
  }

  const { data: { user }, error: authError } = await sb.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: "Невалиден токен." });
  }

  // 2. Parse file with busboy
  let fileBuffer    = null;
  let fileName      = "";
  let mimeType      = "";
  let fileSize      = 0;
  let title         = "";
  let description   = "";
  let access        = "free";
  let uploadError   = null;

  const bb = busboy({ 
    headers: req.headers,
    limits: { fileSize: MAX_SIZE }
  });

  const chunks = [];

  bb.on("file", (field, file, info) => {
    mimeType = info.mimeType;
    fileName = info.filename.replace(/[^a-zA-Z0-9._-]/g, "_").toLowerCase();

    // 3. Check file type
    if (!ALLOWED_TYPES.includes(mimeType)) {
      uploadError = "Невалиден тип файл. Само MP4, MOV, AVI, WebM.";
      file.resume();
      return;
    }

    file.on("data", (chunk) => {
      fileSize += chunk.length;
      if (fileSize > MAX_SIZE) {
        uploadError = "Файлът е твърде голям. Максимум 4GB.";
        file.resume();
        return;
      }
      chunks.push(chunk);
    });

    file.on("limit", () => {
      uploadError = "Файлът надвишава 4GB.";
    });
  });

  bb.on("field", (name, val) => {
    if (name === "title")       title       = val.slice(0, 200);
    if (name === "description") description = val.slice(0, 2000);
    if (name === "access")      access      = val;
  });

  bb.on("finish", async () => {
    if (uploadError) {
      return res.status(400).json({ error: uploadError });
    }

    if (chunks.length === 0) {
      return res.status(400).json({ error: "Няма файл." });
    }

    if (!title) {
      return res.status(400).json({ error: "Заглавието е задължително." });
    }

    fileBuffer = Buffer.concat(chunks);

    // 4. Generate unique key
    const ext = fileName.split(".").pop();
    const key = `videos/${user.id}/${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;

    try {
      // 5. Upload to R2
      await s3.send(new PutObjectCommand({
        Bucket:      BUCKET,
        Key:         key,
        Body:        fileBuffer,
        ContentType: mimeType,
      }));

      const fileUrl = `${process.env.R2_PUBLIC_URL || ""}/${key}`;

      // 6. Save to Supabase
      const { error: dbError } = await sb.from("videos").insert({
        user_id:     user.id,
        title:       title,
        description: description,
        file_url:    fileUrl,
        access_level: access,
      });

      if (dbError) {
        console.error("DB error:", dbError);
      }

      res.json({
        success: true,
        url:     fileUrl,
        key:     key,
        title:   title,
      });

    } catch (err) {
      console.error("Upload error:", err);
      res.status(500).json({ error: "Грешка при качване в R2." });
    }
  });

  req.pipe(bb);
});

app.listen(PORT, () => {
  console.log(`Krevio Backend v2.0 on port ${PORT}`);
});
