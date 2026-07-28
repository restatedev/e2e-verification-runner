// Copyright (c) 2023 - Restate Software, Inc., Restate GmbH
//
// This file is part of the Restate e2e tests,
// which are released under the MIT license.
//
// You can find a copy of the license in file LICENSE in the root
// directory of this repository or package, or at
// https://github.com/restatedev/e2e/blob/main/LICENSE

import { Kafka, Partitioners, type Producer } from "kafkajs";
import type { Program } from "./commands";

/**
 * Produces interpreter programs onto a Kafka topic instead of submitting them
 * over the Restate HTTP ingress. The `ingress-integration-kafka` container
 * consumes the topic and streams each record into Restate via the gRPC
 * IntegrationSvc. Its StaticRecordMapper maps the record key to the
 * virtual-object key and the record value (bytes) to the invocation payload,
 * targeting a fixed service/handler (ObjectInterpreterL0/interpret), configured
 * on that container.
 *
 * The record key is `interpreterId` and the value is `JSON.stringify(program)`
 * -- byte-for-byte the same body the HTTP path (`sendInterpreter`) sends.
 */
export interface InterpreterProducer {
  send(interpreterId: string, program: Program): Promise<void>;
  disconnect(): Promise<void>;
}

export async function createInterpreterProducer(opts: {
  brokers: string[];
  topic: string;
  partitions: number;
}): Promise<InterpreterProducer> {
  const kafka = new Kafka({ clientId: "e2e-driver", brokers: opts.brokers });

  // Pre-create the topic so the consumer (KAFKA_AUTO_OFFSET_RESET=earliest) can
  // read everything regardless of producer/consumer startup ordering.
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [
        {
          topic: opts.topic,
          numPartitions: opts.partitions,
          replicationFactor: 1,
        },
      ],
    }); // idempotent: resolves false if the topic already exists
  } finally {
    await admin.disconnect();
  }

  // Idempotent producer (acks=all, enable.idempotence, in-flight=1) replaces the
  // per-invocation idempotency-key header, which the static mapper cannot carry.
  // Cross-rebalance exactly-once into Restate is the integration container's job.
  const producer: Producer = kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    createPartitioner: Partitioners.DefaultPartitioner,
  });
  await producer.connect();

  return {
    async send(interpreterId: string, program: Program): Promise<void> {
      await producer.send({
        topic: opts.topic,
        messages: [{ key: interpreterId, value: JSON.stringify(program) }],
      });
    },
    async disconnect(): Promise<void> {
      await producer.disconnect();
    },
  };
}
