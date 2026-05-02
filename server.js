import express from "express";
import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createClient } from "@supabase/supabase-js";
import busboy from "busboy";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { writeFile, unlink, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";

// Кажи на fluent-ffmpeg къде е ffmpeg binary
ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.options("*", (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Requested-With");
  res.set("Access-Control-Max-Age", "86400");
  res.status(204).end();
});
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,Authorization,X-Requested-With");
  next();
});

const sb     = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
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

// ====== ТРАНСКОДИРАНЕ В H.264 ======
function transcodeToH264(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        "-c:v libx264",      // H.264 video codec
        "-preset fast",       // Бързо кодиране
        "-crf 28",            // Качество (18=отлично, 28=добро/малък файл)
        "-c:a aac",           // AAC audio
        "-b:a 128k",          // Audio bitrate
        "-movflags +faststart", // MP4 оптимизация за стрийминг
        "-vf scale=trunc(iw/2)*2:trunc(ih/2)*2", // Осигурява четни размери
      ])
      .output(outputPath)
      .on("start", (cmd) => console.log("FFmpeg started:", cmd))
      .on("progress", (p) => console.log("Transcoding:", Math.round(p.percent || 0) + "%"))
      .on("end", () => { console.log("Transcoding done"); resolve(); })
      .on("error", (err) => { console.error("FFmpeg error:", err.message); reject(err); })
      .run();
  });
}

// ====== ИЗВЛИЧАНЕ НА THUMBNAIL ======
function extractThumbnail(inputPath, thumbPath) {
  return new Promise((resolve) => {
    ffmpeg(inputPath)
      .screenshots({
        timestamps: ["00:00:01"],
        filename: thumbPath,
        size: "360x640",
      })
      .on("end", () => { console.log("Thumbnail extracted"); resolve(true); })
      .on("error", (err) => { console.error("Thumbnail error:", err.message); resolve(false); });
  });
}

app.get("/", (req, res) => res.json({ status: "Krevio Backend OK", version: "14.0" }));

app.post("/upload", async (req, res) => {
  console.log("=== UPLOAD HIT ===");

  const id = randomBytes(8).toString("hex");
  const tmpIn   = join(tmpdir(), `krevio_in_${id}`);
  const tmpOut  = join(tmpdir(), `krevio_out_${id}.mp4`);
  const tmpThumb = join(tmpdir(), `krevio_thumb_${id}.jpg`);

  try {
    const videoChunks = []; const thumbChunks = [];
    let title = "", description = "", access = "free", token = "";
    let hasClientThumb = false;

    const bb = busboy({ headers: req.headers, limits: { fileSize: 4 * 1024 * 1024 * 1024 } });

    bb.on("field", (name, val) => {
      if (name === "title")       title       = val;
      if (name === "description") description = val;
      if (name === "access")      access      = val;
      if (name === "token")       token       = val;
    });

    bb.on("file", (name, file, info) => {
      if (name === "video") {
        file.on("data", (chunk) => videoChunks.push(chunk));
      } else if (name === "thumbnail") {
        hasClientThumb = true;
        file.on("data", (chunk) => thumbChunks.push(chunk));
      } else {
        file.resume();
      }
    });

    bb.on("finish", async () => {
      try {
        // Auth
        if (!token) return res.status(401).json({ error: "Не си влязъл." });
        const { data, error } = await sbAuth.auth.getUser(token);
        if (error || !data?.user) return res.status(401).json({ error: "Невалиден токен." });
        const user = data.user;
        if (!title) return res.status(400).json({ error: "Няма заглавие." });
        if (videoChunks.length === 0) return res.status(400).json({ error: "Няма файл." });

        // Запиши входния файл
        const fileBuffer = Buffer.concat(videoChunks);
        console.log("Input size:", fileBuffer.length);
        await writeFile(tmpIn, fileBuffer);

        // Транскодирай в H.264
        console.log("Transcoding to H.264...");
        await transcodeToH264(tmpIn, tmpOut);

        // Прочети транскодирания файл
        const outBuffer = await readFile(tmpOut);
        console.log("Output size:", outBuffer.length);

        // Качи видеото в R2
        const key = `videos/${user.id}/${Date.now()}.mp4`;
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET, Key: key,
          Body: outBuffer, ContentType: "video/mp4",
          CacheControl: "public, max-age=31536000",
        }));
        const fileUrl = `${process.env.R2_PUBLIC_URL}/${key}`;
        console.log("Video uploaded:", fileUrl);

        // Thumbnail — използвай клиентския или извлечи от видеото
        let thumbnailUrl = null;
        try {
          let thumbBuffer = null;

          if (hasClientThumb && thumbChunks.length > 0) {
            // Клиентът е изпратил thumbnail
            thumbBuffer = Buffer.concat(thumbChunks);
            console.log("Using client thumbnail, size:", thumbBuffer.length);
          } else {
            // Извлечи от транскодираното видео
            const thumbOk = await extractThumbnail(tmpOut, tmpThumb);
            if (thumbOk) {
              thumbBuffer = await readFile(tmpThumb);
              console.log("Extracted thumbnail, size:", thumbBuffer.length);
            }
          }

          if (thumbBuffer) {
            const thumbKey = `thumbnails/${user.id}/${Date.now()}.jpg`;
            await s3.send(new PutObjectCommand({
              Bucket: BUCKET, Key: thumbKey,
              Body: thumbBuffer, ContentType: "image/jpeg",
              CacheControl: "public, max-age=31536000",
            }));
            thumbnailUrl = `${process.env.R2_PUBLIC_URL}/${thumbKey}`;
            console.log("Thumbnail uploaded:", thumbnailUrl);
          }
        } catch(thumbErr) {
          console.error("Thumbnail failed (non-fatal):", thumbErr.message);
        }

        // Запиши в Supabase
        await sb.from("videos").insert({
          user_id: user.id, title,
          description: description || "",
          file_url: fileUrl,
          access_level: access || "free",
          thumbnail_url: thumbnailUrl,
        });

        res.json({ fileUrl, thumbnailUrl });

      } catch(e) {
        console.error("Upload error:", e.message);
        res.status(500).json({ error: e.message });
      } finally {
        // Изчисти временните файлове
        for (const p of [tmpIn, tmpOut, tmpThumb]) {
          try { await unlink(p); } catch(e) {}
        }
      }
    });

    req.pipe(bb);
  } catch(e) {
    res.status(500).json({ error: e.message });
    for (const p of [tmpIn, tmpOut, tmpThumb]) {
      try { await unlink(p); } catch(e) {}
    }
  }
});

app.delete("/delete-video", async (req, res) => {
  console.log("=== DELETE VIDEO HIT ===");
  try {
    const { token, fileUrl, videoId } = req.body;
    if (!token) return res.status(401).json({ error: "Не си влязъл." });
    const { data, error } = await sbAuth.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: "Невалиден токен." });
    const user = data.user;

    const { error: dbErr } = await sb.from("videos").delete().eq("id", videoId).eq("user_id", user.id);
    if (dbErr) return res.status(500).json({ error: dbErr.message });

    const key = fileUrl.replace(process.env.R2_PUBLIC_URL + "/", "");
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));

    console.log("Deleted:", videoId, key);
    res.json({ ok: true });
  } catch(e) {
    console.error("Delete error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Krevio Backend v14.0 on port ${PORT}`));
