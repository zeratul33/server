// server.ts

import express, { Request, Response } from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import axios from 'axios';
import mongoose from 'mongoose';
import ngeohash from 'ngeohash';

// 1. 初始化和环境配置
// -----------------------------------------------------
dotenv.config();

const app = express();
const PORT = process.env.PORT || 8000;

// 从环境变量中获取敏感信息
const TICKETMASTER_API_KEY = process.env.TICKETMASTER_API_KEY;
const IPINFO_TOKEN = process.env.IPINFO_TOKEN;
const MONGODB_URI = process.env.MONGODB_URI;

const MONGODB_PASSWORD = process.env.MONGODB_PASSWORD;

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAP_KEY;

const TICKETMASTER_API_BASE = 'https://app.ticketmaster.com/discovery/v2';

// 2. 中间件设置
// -----------------------------------------------------
app.use(cors()); // 允许跨域请求
app.use(express.json()); // 解析JSON格式的请求体

// 3. MongoDB 连接和模型定义
// -----------------------------------------------------
if (!MONGODB_URI) {
  console.error('错误: MONGODB_URI 未在 .env 文件中定义。');
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
  .then(() => console.log('成功连接到 MongoDB Atlas'))
  .catch(err => console.error('MongoDB 连接失败:', err));

// 定义收藏事件的 Schema
const FavoriteSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  date: { type: String, },
  time: { type: String },
  category: { type: String },
  venue: { type: String },
  image: { type: String },
});

  // _id:string;
  // id: string;
  // name: string;
  // venue: string;
  // date: string;
  // time: string;
  // category: string;
  // image: string;

const Favorite = mongoose.model('Favorite', FavoriteSchema);


// 4. API 路由定义
// -----------------------------------------------------

// --- Ticketmaster API 代理 ---

/**
 * @route   GET /api/suggest
 * @desc    获取 Ticketmaster 的搜索建议
 * @access  Public
 * @query   keyword: string
 */
app.get('/api/suggest', async (req: Request, res: Response) => {
  const { keyword } = req.query;
  console.log(keyword);
  

  if (!keyword) {
    return res.status(400).json({ message: '缺少 keyword 查询参数' });
  }

  try {
    const url = `${TICKETMASTER_API_BASE}/suggest.json?apikey=${TICKETMASTER_API_KEY}&keyword=${keyword}`;
    const response = await axios.get(url);
    const result = response.data._embedded;
    const events = result.events;
    return res.json(events);
  } catch (error) {
    console.error('获取建议失败:', error);
    res.status(500).json({ message: '服务器内部错误' });
  }
});

/**
 * @route   GET /api/events/search
 * @desc    搜索 Ticketmaster 事件
 * @access  Public
 * @query   keyword, category, city, ipAddress, autoDetect, distance
 */
app.post('/api/events/search', async (req: Request, res: Response) => {
  try {
    const { keyword, category, location, ipAddress, autoDetect, distance,latlong } = req.body;

    console.log(req.query);
    

    // 构建 Ticketmaster API 请求参数
    const params: any = {
      apikey: TICKETMASTER_API_KEY,
      keyword: keyword || '',
      latlong: latlong || '',
      radius: distance || 10, // 默认搜索半径为10英里
      unit: 'miles',
      sort: "relevance,desc",
      size:20
    };

    // Ticketmaster 使用 segmentName 作为分类
    if (category && category !== 'All') {
      params.classificationName = category;
    }

    // 自动检测位置逻辑
    if (autoDetect && ipAddress) {
      // 1. 使用 IPinfo 获取经纬度
      const ipinfoResponse = await axios.get(`https://ipinfo.io/${ipAddress}?token=${IPINFO_TOKEN}`);
      const { loc } = ipinfoResponse.data; // e.g., "34.0522,-118.2437"
      
      if (!loc) {
        return res.status(404).json({ message: '无法根据IP地址获取位置信息' });
      }

      const [latitude, longitude] = loc.split(',').map(Number);

      // 2. 使用 ngeohash 将经纬度转换为 geohash
      const geohash = ngeohash.encode(latitude, longitude, 9); // 精度为9
      params.geoPoint = geohash;

    } else {
      // 手动指定城市逻辑
      if (location) {
        console.log('手动指定城市逻辑');
        
        // const resp = await axios.get(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(location)}&key=${GOOGLE_MAPS_API_KEY}`)
        // console.log(resp.data);
        
        // const {lat, lng} = resp.data.results[0].geometry.location;
        // params.latlong = String(lat)+','+String(lng);
        console.log(params);
        
      }
    }
    console.log(params);
    

    // 调用 Ticketmaster API
    const response = await axios.get(`${TICKETMASTER_API_BASE}/events.json`, { params });

    // Ticketmaster 在没有结果时可能不返回 _embedded 字段
    const events = response.data?._embedded?.events || [];
    res.json(events);

  } catch (error: any) {
    console.error('事件搜索失败:', error);
    res.status(500).json({ message: '事件搜索时发生服务器错误' });
  }
});

/**
 * @route   GET /api/events/:id
 * @desc    获取单个事件的详情
 * @access  Public
 * @param   id: string (事件ID)
 */
app.get('/api/events/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  try {
    const url = `${TICKETMASTER_API_BASE}/events/${id}.json?apikey=${TICKETMASTER_API_KEY}`;
    const response = await axios.get(url);
    res.json(response.data);
  } catch (error: any) {
    console.error(`获取事件 ${id} 详情失败:`, error.response?.data || error.message);
    if(error.response?.status === 404) {
      return res.status(404).json({ message: '事件未找到' });
    }
    res.status(500).json({ message: '获取事件详情时发生服务器错误' });
  }
});


// --- 收藏夹 API (MongoDB) ---

/**
 * @route   GET /api/favorites
 * @desc    获取所有收藏的事件
 * @access  Public
 */
app.get('/api/favorites', async (req: Request, res: Response) => {
  try {
    const favorites = await Favorite.find();
    res.json(favorites);
  } catch (error) {
    console.error('获取收藏列表失败:', error);
    res.status(500).json({ message: '服务器内部错误' });
  }
});

/**
 * @route   POST /api/favorites
 * @desc    添加一个新的收藏事件
 * @access  Public
 * @body    { id, name, date, venue, imageUrl, url }
 */
app.post('/api/favorites', async (req: Request, res: Response) => {
  try {
    console.log('添加收藏事件:', req.body);
    
    const { id } = req.body;

    // 检查是否已收藏
    const existingFavorite = await Favorite.findOne({ id });
    if (existingFavorite) {
      return res.status(409).json({ message: '该事件已在收藏夹中' }); // 409 Conflict
    }

    const newFavorite = new Favorite(req.body);
    await newFavorite.save();
    console.log('收藏成功');
    
    res.status(201).json(newFavorite); // 201 Created
  } catch (error) {
    console.error('添加收藏失败:', error);
    res.status(500).json({ message: '服务器内部错误' });
  }
});

/**
 * @route   DELETE /api/favorites/:eventId
 * @desc    从收藏夹中移除一个事件
 * @access  Public
 * @param   eventId: string
 */
app.delete('/api/favorites/:id', async (req: Request, res: Response) => {
  try {
    console.log('删除收藏');
    
    const { id } = req.params;
    const result = await Favorite.findOneAndDelete({ id });

    if (!result) {
      return res.status(404).json({ message: '在收藏夹中未找到该事件' });
    }

    res.status(204).send(); // 204 No Content
    console.log('取消收藏成功');
    
  } catch (error) {
    console.error('取消收藏失败:', error);
    res.status(500).json({ message: '服务器内部错误' });
  }
});


// 5. 启动服务器
// -----------------------------------------------------
app.listen(PORT, () => {
  console.log(`服务器正在 http://localhost:${PORT} 上运行`);
});


const { MongoClient, ServerApiVersion } = require('mongodb');
const uri = `mongodb+srv://zeratulhe_db_user:${MONGODB_PASSWORD}@cluster0.vw6rhxv.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    await client.close();
  }
}
run().catch(console.dir);

