import { Request, Response, NextFunction } from 'express';

declare const _default: {
    init: typeof init;
    getGitCommitHash: typeof getGitCommitHash;
};

interface Config {
    secret: string;
    routePrefix: string;
    updateUrlKeyName: string;
    restartFunction: () => void;
    port: number;
    httpProto: string;
    authMiddleware?: (req: Request, res: Response, next: NextFunction) => void;
    repoDir: string;
    consoleLog: (...args: any[]) => void;
    errorLog: (...args: any[]) => void;
    updateLaunchDefault: boolean;
    removeOldTarget: boolean;
    remoteRepoPrefix?: string;
    metadataOpts?: any;
    asgName?: string;
    region?: string;
}
declare function init(router: any, config: Partial<Config>): void;
declare function getGitCommitHash(done: (err: any, result?: string) => void): void;

export { _default as default, getGitCommitHash, init };
export type { Config };
