import express from "express";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import cors from "cors";
import { createClient } from "@supabase/supabase-js";

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: "*" }));
app.options("*", cors());

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

app.get("/", (req, res) => {
  res.json({ status: "Krevio Backend OK", version: "4.0" });
});

app.post("/presign", async (req, res) => {
  console.log("=== PRESIGN REQUEST ===");

  const token = req.headers.authorization?.replace("Bearer ", "");
  console.log("Token:", token ? "RECEIVED" : "MISSING");

  if (!token) {
    return res.status(401).json({ error: "Не си влязъл." });
  }

  let user = null;
  try {
    const { data, error } = await sb.auth.getUser(token);
    console.log("Auth error:", error);
    console.log("User:", data?.user?.id);
    if (error || !data?.user) {
      return res.status(401).json({ error: "Невалиден токен." });
    }
    user = data.user;
  } catch(e) {
    console.log("Auth exception:", e.message);
    return res.status(401).json({ error: "Грешка при проверка на токена." });
  }

  const { fileName, mimeType, title, description, access } = req.body;
  console.log("Body:", { fileName, mimeType, title });

  if (!fileName || !mimeType || !title) {
    return res.status(400).json({ error: "Липсват данни." });
  }

  try {
    const ext = fileName.split(".").pop();
    const key = `videos/${user.id}/${Date.now()}.${ext}`;

    const command = new PutObjectCommand({
      Bucket:      BUCKET,
      Key:         key,
      ContentType: mimeType,
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const fileUrl   = `${process.env.R2_PUBLIC_URL}/${key}`;

    await sb.from("videos").insert({
      user_id:      user.id,
      title:        title,
      description:  description || "",
      file_url:     fileUrl,
      access_level: access || "free",
    });

    console.log("Presign success:", key);
    res.json({ uploadUrl, fileUrl, key });

  } catch(e) {
    console.log("Presign error:", e.message);
    res.status(500).json({ error: "Грешка при генериране на URL." });
  }
});

app.listen(PORT, () => {
  console.log(`Krevio Backend v4.0 on port ${PORT}`);
});
