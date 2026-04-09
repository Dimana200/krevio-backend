
const express = require("express");
const multer = require("multer");
const AWS = require("aws-sdk");
const cors = require("cors");

const app = express();
app.use(cors());

const upload = multer({ storage: multer.memoryStorage() });

const s3 = new AWS.S3({
  endpoint: `https://${process.env.ACCOUNT_ID}.r2.cloudflarestorage.com`,
  accessKeyId: process.env.ACCESS_KEY,
  secretAccessKey: process.env.SECRET_KEY,
  signatureVersion: "v4",
});

app.post("/upload", upload.single("file"), async (req, res) => {
  try {
    const file = req.file;

    const params = {
      Bucket: "krevio-media",
      Key: Date.now() + "-" + file.originalname,
      Body: file.buffer,
      ContentType: file.mimetype,
    };

    await s3.upload(params).promise();

    res.json({
      success: true,
      url: `https://pub-${process.env.ACCOUNT_ID}.r2.dev/${params.Key}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Upload failed" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
