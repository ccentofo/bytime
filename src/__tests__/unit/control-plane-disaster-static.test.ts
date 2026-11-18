import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { parseDisasterArgs } from '../../../scripts/backup/disaster';

/**
 * feature-plan-control-plane-disaster.md §11 T3 (and the static halves of T6/T13): the 3c-2 additions to the backup
 * stack, the button workflow and the image. U6 (backup-static.test.ts) already checks that every role, rule and policy
 * equals expected-policies.ts, which this item extends.
 */

const ROOT = path.resolve(__dirname, '../../..');
const read = (p: string) => readFileSync(path.join(ROOT, p), 'utf8');
type Node = Record<string, unknown>;
const stackText = read('ops/aws/backup-stack.yml');
const stack = parse(stackText) as { Resources: Record<string, { Type: string; Properties: Node; DependsOn?: string[] }>; Outputs: Record<string, Node> };
const ofType = (type: string) => Object.entries(stack.Resources).filter(([, r]) => r.Type === type);
const BACKUP_ID_PARAM = 'arn:aws:ssm:us-east-1:${AWS::AccountId}:parameter/cadenzpoint/backup/control-plane-backup-id';
const container = (logical: string) => ((stack.Resources[logical].Properties.ContainerDefinitions as Node[])[0]);
const secretsOf = (logical: string) => Object.fromEntries((container(logical).Secrets as Array<{ Name: string; ValueFrom: Node }>).map((s) => [s.Name, s.ValueFrom['Fn::Sub']]));
const envOf = (logical: string) => Object.fromEntries((container(logical).Environment as Array<{ Name: string; Value: unknown }>).map((e) => [e.Name, e.Value]));
const execGrants = (logical: string) => {
  const execRole = ((stack.Resources[logical].Properties.ExecutionRoleArn as Node)['Fn::GetAtt'] as string[])[0];
  const st = ((stack.Resources[execRole].Properties.Policies as Node[])[0].PolicyDocument as Node).Statement as Array<Node>;
  return (st.find((s) => s.Sid === 'ReadParameters')!.Resource as Node[]).map((r) => r['Fn::Sub']);
};

describe('T3: the per-environment backup id (§6.0, §6.2 item 1)', () => {
  it('a secret on the backup, restore-test and disaster task definitions, each with its exec-role grant; never on audit', () => {
    for (const td of ['BackupTaskDefinition', 'RestoreTestTaskDefinition', 'DisasterTaskDefinition']) {
      expect(secretsOf(td).BACKUP_CONTROL_PLANE_ID, td).toBe(BACKUP_ID_PARAM);
      expect(execGrants(td), td).toContain(BACKUP_ID_PARAM);
    }
    expect(secretsOf('AuditTaskDefinition').BACKUP_CONTROL_PLANE_ID).toBeUndefined();
    expect(execGrants('AuditTaskDefinition')).not.toContain(BACKUP_ID_PARAM);
  });
});

describe('T3: the disaster task (§6.2 item 2)', () => {
  it('the restore-test URL secret (with its grant) and DISASTER_LOG_GROUP; the task role reads the disaster log group', () => {
    const url = 'arn:aws:ssm:us-east-1:${AWS::AccountId}:parameter/cadenzpoint/backup/restore-test-url';
    expect(secretsOf('DisasterTaskDefinition').RESTORE_TEST_DATABASE_URL).toBe(url);
    expect(execGrants('DisasterTaskDefinition')).toContain(url);
    expect(envOf('DisasterTaskDefinition').DISASTER_LOG_GROUP).toBe('/cadenzpoint/backup/disaster');
    const st = ((stack.Resources.DisasterTaskRole.Properties.Policies as Node[])[0].PolicyDocument as Node).Statement as Node[];
    const read = st.find((s) => s.Sid === 'ReadBackupLines')!;
    expect(read.Action).toBe('logs:FilterLogEvents');
    expect((read.Resource as Node[]).map((r) => r['Fn::Sub'])).toEqual([
      'arn:aws:logs:us-east-1:${AWS::AccountId}:log-group:/cadenzpoint/backup/backup:*',
      'arn:aws:logs:us-east-1:${AWS::AccountId}:log-group:/cadenzpoint/backup/disaster:*',
    ]);
  });

  it('no statement anywhere in the stack allows ssm:PutParameter (invariant 3)', () => {
    expect(stackText).not.toMatch(/ssm:PutParameter|ssm:\*/);
  });
});

describe('T3: the control-plane rehearsal schedule (§6.2 item 3)', () => {
  const [name, sched] = ofType('AWS::Scheduler::Schedule').find(([, x]) => x.Properties.Name === 'cadenzpoint-backup-disaster-rehearse-cp')!;
  const ws = ofType('AWS::Scheduler::Schedule').find(([, x]) => x.Properties.Name === 'cadenzpoint-backup-disaster-rehearse')![1];
  it('name, cron, UTC and input exact; the input parses as the control-plane rehearsal', () => {
    expect(name).toBe('DisasterRehearseControlPlaneSchedule');
    expect(sched.Properties.ScheduleExpression).toBe('cron(17 15 15 * ? *)');
    expect(sched.Properties.ScheduleExpressionTimezone).toBe('UTC');
    const input = (sched.Properties.Target as Node).Input as string;
    expect(input).toBe('{"containerOverrides":[{"name":"disaster","command":["disaster", "rehearse", "--targets", "control-plane"]}]}');
    const cmd = (JSON.parse(input) as { containerOverrides: Array<{ command: string[] }> }).containerOverrides[0].command;
    expect(parseDisasterArgs(cmd.slice(1))).toMatchObject({ ok: true, args: { mode: 'rehearse', targets: 'control-plane', override: 'none' } });
  });
  it('the same target, role, retry, dead-letter queue, network and DependsOn as the workspace rehearsal', () => {
    const strip = (t: Node) => ({ ...t, Input: undefined });
    expect(strip(sched.Properties.Target as Node)).toEqual(strip(ws.Properties.Target as Node));
    expect(sched.DependsOn).toEqual(ws.DependsOn);
    expect(sched.Properties.FlexibleTimeWindow).toEqual({ Mode: 'OFF' });
  });
  it('the start-email template names both monthly rehearsals', () => {
    const rule = stack.Resources.DisasterStartedRule.Properties;
    const tmpl = JSON.stringify(rule);
    expect(tmpl).toContain('workspace on the 1st, control plane on the 15th, both 15:17 UTC');
  });
});

describe('T3/T6: the DisasterModes output (§6.1)', () => {
  it('lists exactly the four modes plus the control-plane rehearsal', () => {
    expect(stack.Outputs.DisasterModes).toEqual({ Value: 'workspace rehearse control-plane reconcile rehearse-control-plane' });
  });
  it('the button workflow offers the four modes', () => {
    const wf = parse(read('.github/workflows/disaster-restore.yml')) as { on: { workflow_dispatch: { inputs: { mode: { options: string[] } } } } };
    expect(wf.on.workflow_dispatch.inputs.mode.options).toEqual(['workspace', 'rehearse', 'control-plane', 'reconcile']);
  });
});

describe('T13: the task constructs no SSM-write, Vercel or Stripe client (invariant 3)', () => {
  it('no bundled module imports an SSM, Vercel or Stripe client, or names PutParameterCommand (expected-policies.ts names the PutParameter EVENT only, for its alarm)', async () => {
    const { build } = await import('esbuild');
    const { BUNDLE_OPTIONS } = await import('../../../scripts/backup/bundle.mjs');
    const r = await build({ ...(BUNDLE_OPTIONS as import('esbuild').BuildOptions), absWorkingDir: ROOT, write: false, metafile: true, logLevel: 'silent' });
    const inputs = Object.keys(r.metafile!.inputs);
    expect(inputs.filter((i) => /@aws-sdk\/client-ssm|node_modules\/stripe\/|@vercel\/|node_modules\/vercel\//.test(i))).toEqual([]);
    for (const f of inputs.filter((i) => !i.startsWith('node_modules/'))) {
      const text = read(f);
      expect(text, f).not.toMatch(/PutParameterCommand|ssm:PutParameter|api\.vercel\.com|api\.stripe\.com|STRIPE_SECRET_KEY|VERCEL_TOKEN/);
    }
  }, 120_000);
});
