import express from "express";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createClient } from "@supabase/supabase-js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import https from "https";

const execAsync = promisify(exec);
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const sbAuth = createClient(
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

// Помощна функция — изтегля файл от URL
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, (response) => {
      response.pipe(file);
      file.on("finish", () => { file.close(); resolve(); });
    }).on("error", (err) => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

// Генерира thumbnail от видео с ffmpeg
async function generateThumbnail(videoUrl, userId, videoKey) {
  const tmpDir = "/tmp";
  const videoPath = path.join(tmpDir, `vid_${Date.now()}.mp4`);
  const thumbPath = path.join(tmpDir, `thumb_${Date.now()}.jpg`);

  try {
    console.log("Downloading video for thumbnail...");
    await downloadFile(videoUrl, videoPath);

    console.log("Generating thumbnail with ffmpeg...");
    // Взимаме кадър на 1 секунда
    await execAsync(`ffmpeg -i "${videoPath}" -ss 00:00:01 -vframes 1 -vf "scale=480:-1" -q:v 2 "${thumbPath}" -y`);

    // Качваме thumbnail в R2
    const thumbKey = `thumbnails/${userId}/${path.basename(videoKey, path.extname(videoKey))}.jpg`;
    const thumbBuffer = fs.readFileSync(thumbPath);

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: thumbKey,
      Body: thumbBuffer,
      ContentType: "image/jpeg",
    }));

    const thumbUrl = `${process.env.R2_PUBLIC_URL}/${thumbKey}`;
    console.log("Thumbnail uploaded:", thumbUrl);
    return thumbUrl;

  } catch(e) {
    console.error("Thumbnail generation failed:", e.message);
    return null;
  } finally {
    // Почистваме временните файлове
    try { fs.unlinkSync(videoPath); } catch(e) {}
    try { fs.unlinkSync(thumbPath); } catch(e) {}
  }
}

app.get("/", (req, res) => {
  res.json({ status: "Krevio Backend OK", version: "7.0" });
});

app.post("/presign", async (req, res) => {
  console.log("=== PRESIGN HIT ===");

  const token = req.headers.authorization?.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Не си влязъл." });

  try {
    const { data, error } = await sbAuth.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: "Невалиден токен." });
    }

    const user = data.user;
    const { fileName, mimeType, title, description, access } = req.body;

    if (!fileName || !mimeType || !title) {
      return res.status(400).json({ error: "Липсват данни." });
    }

    const ext = fileName.split(".").pop();
    const key = `videos/${user.id}/${Date.now()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      ContentType: mimeType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const fileUrl   = `${process.env.R2_PUBLIC_URL}/${key}`;

    // Записваме видеото в DB без thumbnail засега
    const { error: dbError } = await sb.from("videos").insert({
      user_id:      user.id,
      title:        title,
      description:  description || "",
      file_url:     fileUrl,
      access_level: access || "free",
      thumbnail_url: null,
    });

    if (dbError) {
      console.log("DB error:", dbError.message);
    } else {
      console.log("DB insert OK");
    }

    // Връщаме presigned URL веднага — не чакаме thumbnail
    res.json({ uploadUrl, fileUrl, key });

    // Генерираме thumbnail СЛЕД качването асинхронно
    // Чакаме 10 секунди за да може файлът да се качи в R2
    setTimeout(async () => {
      console.log("Starting async thumbnail generation for:", key);
      const thumbUrl = await generateThumbnail(fileUrl, user.id, key);
      if (thumbUrl) {
        // Обновяваме видеото с thumbnail_url
        const { error: updateErr } = await sb.from("videos")
          .update({ thumbnail_url: thumbUrl })
          .eq("file_url", fileUrl);
        if (updateErr) console.error("Thumbnail DB update error:", updateErr.message);
        else console.log("Thumbnail saved to DB:", thumbUrl);
      }
    }, 10000);

  } catch(e) {
    console.log("Error:", e.message);
    res.status(500).json({ error: "Сървърна грешка." });
  }
});

app.listen(PORT, () => {
  console.log(`Krevio Backend v7.0 on port ${PORT}`);
});
