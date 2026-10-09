import { Request, Response, NextFunction } from 'express';
import { AutoScalingClientConfig } from '@aws-sdk/client-auto-scaling';
import { EC2ClientConfig } from '@aws-sdk/client-ec2';
import { S3ClientConfig } from '@aws-sdk/client-s3';

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
    s3region?: string;
    ec2ClientConfig?: EC2ClientConfig;
    autoScalingClientConfig?: AutoScalingClientConfig;
    s3ClientConfig?: S3ClientConfig;
}
declare function init(router: any, config: Partial<Config>): void;
declare function getGitCommitHash(done: (err: any, result?: string) => void): void;

export { _default as default, getGitCommitHash, init };
export type { Config };
