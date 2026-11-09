import { MongoClient, type Db } from "mongodb";

let client: MongoClient;

export const connectMongo = (): Promise<Db> => {
    const uri = process.env.MONGODB_URI;

    if(!uri){
        return Promise.reject(new Error("Falta MONGODB_URI en el archivo .env"));
    }

    client = new MongoClient(uri);

    return client.connect().then(() => {
        console.log("Conectado a MongoDB");
        return client.db();
    });
}

export const createSession = () => {
    return client.startSession();
}

export const closeMongo = () => {
    return client?.close();
}
