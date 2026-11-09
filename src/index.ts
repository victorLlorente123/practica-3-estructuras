import express, { type NextFunction, type Request, type Response } from "express";
import { loadEnvFile } from "node:process";
import type { Collection } from "mongodb";
import { connectMongo, closeMongo } from "./config/database.js";
import { configClienteCollection } from "./controllers/clientes.controller.js";
import { configCuentaCollection } from "./controllers/cuentas.controller.js";
import { configMovimientoCollection } from "./controllers/movimientos.controller.js";
import type { ClienteT } from "./models/clientes.model.js";
import type { CuentaT } from "./models/cuentas.model.js";
import type { MovimientoT } from "./models/movimientos.model.js";
import clientesRoutes from "./routes/clientes.routes.js";
import cuentasRoutes from "./routes/cuentas.routes.js";
import transferenciasRoutes from "./routes/transferencias.routes.js";

const app = express();

loadEnvFile();

app.use(express.json());

const startServer = () => {
    const PORT = Number(process.env.PORT);

    if(!Number.isInteger(PORT) || PORT < 1 || PORT > 65535){
        console.error("PORT debe ser un entero entre 1 y 65535 en el archivo .env");
        process.exitCode = 1;
        return;
    }

    connectMongo().then((db) => {
        const clientesCollection: Collection<ClienteT> = db.collection("clientes");
        const cuentasCollection: Collection<CuentaT> = db.collection("cuentas");
        const movimientosCollection: Collection<MovimientoT> = db.collection("movimientos");

        configClienteCollection(clientesCollection);
        configCuentaCollection(cuentasCollection, clientesCollection);
        configMovimientoCollection(movimientosCollection, cuentasCollection);

        return clientesCollection.createIndex({ email: 1 }, { unique: true }).then(() => {
            return clientesCollection.createIndex({ dni: 1 }, { unique: true });
        }).then(() => {
            return cuentasCollection.createIndex({ iban: 1 }, { unique: true });
        }).then(() => {
            return cuentasCollection.createIndex({ clienteId: 1, estado: 1 });
        }).then(() => {
            return movimientosCollection.createIndex({ cuentaId: 1, fecha: -1 });
        });
    }).then(() => {
        app.use("/clientes", clientesRoutes);
        app.use("/cuentas", cuentasRoutes);
        app.use("/transferencias", transferenciasRoutes);

        app.use((req, res) => {
            res.status(404).json({ error: "Ruta no encontrada" });
        });

        app.use((error: Error & { status?: number }, req: Request, res: Response, next: NextFunction) => {
            if(error.status && error.status >= 400 && error.status < 500){
                res.status(400).json({ error: "La petición no contiene un JSON válido o supera el tamaño permitido" });
                return;
            }

            res.status(500).json({ error: "Error inesperado del servidor" });
        });

        const server = app.listen(PORT, () => {
            console.log(`API funcionando en el puerto ${PORT}`);
        });

        server.on("error", () => {
            console.error("No se ha podido iniciar el servidor en el puerto indicado");
            closeMongo();
            process.exitCode = 1;
        });
    }).catch(() => {
        console.error("No se ha podido conectar a MongoDB o crear los índices");
        closeMongo();
        process.exitCode = 1;
    });
}

startServer();
