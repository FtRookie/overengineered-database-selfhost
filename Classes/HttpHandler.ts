
import { Elysia, t } from 'elysia';
import { DatabaseInteractions } from './DatabaseInteractions';
import { Database } from "bun:sqlite";
import { write_token } from '../Access Tokens/securityTokens';

export namespace HttpHandler
{
    export const init = (db: Database, port: number) =>
    {
        const app = new Elysia();
        app.listen(port);

        app.get('/player/:id', ({ params: { id } }) =>
        {
            const player = DatabaseInteractions.getPlayerDataEntryByID(db, id);
            return player ?? { error: 'Not found' };
        });

        app.get('/save/:id', ({ params: { id } }) =>
        {
            const player = DatabaseInteractions.getSavesOfPlayerByID(db, id);
            return player ?? { error: 'Not found' };
        });

        app.post('/player', ({ body }) =>
        {
            DatabaseInteractions.insertPlayers(db, [body]);
            if (body.token !== write_token) return { error: "incorrect token" };
            return { status: 'ok' };
        }, {
            body: t.Object({
                slotIndex: t.Integer(),
                playerId: t.String(),
                data: t.String(),
                token: t.String(),
            })
        });

        app.post('/save', ({ body }) =>
        {
            DatabaseInteractions.insertSave(db, [body]);
            if (body.token !== write_token) return { error: "incorrect token" };
            return { status: 'ok' };
        }, {
            body: t.Object({
                playerId: t.String(),
                data: t.String(),
                token: t.String(),
            })
        });

        console.log(`HTTP is running on http://localhost:${port}`);
    }
}