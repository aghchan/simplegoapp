package mongo

import (
	"context"
	"fmt"

	"github.com/aghchan/simplegoapp/pkg/logger"
	"go.mongodb.org/mongo-driver/bson"
	"go.mongodb.org/mongo-driver/bson/primitive"
	"go.mongodb.org/mongo-driver/mongo"
	"go.mongodb.org/mongo-driver/mongo/options"
	"go.mongodb.org/mongo-driver/mongo/readpref"
)

type Service interface {
	Find(collection string, filter, result interface{}, opts ...*options.FindOptions) error
	Insert(collection string, documents []interface{}, opts ...*options.InsertManyOptions) ([]ObjectID, error)
	Update(collection string, filter, update interface{}, opts ...*options.UpdateOptions) error
	FindOneAndUpdate(collection string, filter, update, result interface{}, opts ...*options.FindOneAndUpdateOptions) error
}

type D = bson.D
type E = bson.E
type A = bson.A 
type M = bson.M

type ObjectID = primitive.ObjectID

func NewService(config map[string]interface{}, logger logger.Logger) Service {
	return &service{
		logger: logger,
		database: connect(
			config["mongo_host"].(string),
			config["mongo_port"].(string),
			config["mongo_database"].(string),
		),
	}
}

type service struct {
	logger logger.Logger

	database *mongo.Database
}

func connect(host, port, database string) *mongo.Database {
	client, err := mongo.Connect(
		context.TODO(),
		options.Client().ApplyURI(fmt.Sprintf("mongodb://%s%s%s", host, ":", port)),
	)
	if err != nil {
		panic("connecting to mongo: " + err.Error())
	}

	if err := client.Ping(context.TODO(), readpref.Primary()); err != nil {
		panic("checking mongo connection: " + err.Error())
	}

	return client.Database(database)
}

func (this service) Find(collection string, filter, result interface{}, opts ...*options.FindOptions) error {
	cursor, err := this.database.Collection(collection).Find(context.TODO(), filter, opts...)
	if err != nil {
		return err
	}

	err = cursor.All(context.TODO(), result)
	if err != nil {
		return err
	}

	return nil
}

func (this service) Insert(collection string, documents []interface{}, opts ...*options.InsertManyOptions) ([]ObjectID, error) {
	cursor, err := this.database.Collection(collection).InsertMany(context.TODO(), documents, opts...)
	if err != nil {
		return nil, err
	}

	insertedIds := make([]ObjectID, len(cursor.InsertedIDs))
	for i, v := range cursor.InsertedIDs {
		insertedIds[i] = v.(ObjectID)
	}

	return insertedIds, nil
}

func (this service) Update(collection string, filter, update interface{}, opts ...*options.UpdateOptions) error {
	_, err := this.database.Collection(collection).UpdateMany(context.TODO(), filter, update, opts...)
	if err != nil {
		return err
	}

	return nil
}

func (this service) FindOneAndUpdate(collection string, filter, update, result interface{}, opts ...*options.FindOneAndUpdateOptions) error {
	cursor := this.database.Collection(collection).FindOneAndUpdate(context.TODO(), filter, update, opts...)
	if cursor.Err() != nil {
		return cursor.Err()
	}

	err := cursor.Decode(result)
	if err != nil {
		return err
	}

	return nil
}
