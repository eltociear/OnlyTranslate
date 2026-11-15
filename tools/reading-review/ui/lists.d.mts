export interface ListPage<T> {items:T[];page:number;pageSize:number;total:number;pageCount:number;start:number;end:number}
export function paginate<T>(items:T[],page?:number,pageSize?:number):ListPage<T>
export function jobGroup(status:string):'running'|'queued'|'ended'
export function isEvaluationPage(page:{inputState?:{state?:string}}):boolean
export function countJobs(jobs:{status:string}[]):{running:number;queued:number;ended:number}
export function sortJobs<T extends {id:string;status:string;createdAt?:string;finishedAt?:string}>(jobs:T[]):T[]
export function renderPager(element:any,list:ListPage<unknown>,kind:'pages'|'pending'|'jobs'):void
