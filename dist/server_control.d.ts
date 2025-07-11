declare const _default: {
    init: typeof init;
    getGitCommitHash: typeof getGitCommitHash;
};

interface Config {
    route_prefix: string;
    secret: string;
    sc_update_url_key_name: string;
    restart_function: () => void;
    service_port: number;
    http_proto: string;
    auth_middleware: boolean | ((req: any, res: any, next: any) => void);
    repo_dir: string;
    console_log: (...args: any[]) => void;
    error_log: (...args: any[]) => void;
    update_launch_default: boolean;
    remove_old_target: boolean;
    remote_repo_prefix?: string;
    metadata_opts?: any;
    asg_name?: string;
    region?: string;
}
declare function init(app: any, config: Partial<Config>): void;
declare function getGitCommitHash(done: (err: any, result?: string) => void): void;

export { _default as default, getGitCommitHash, init };
export type { Config };
